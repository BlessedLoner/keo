import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import type { IndexBackend, IndexRow } from './fileSearch';
import { IndexUnavailable } from './fileSearch';

/**
 * The Windows Search index through a resident PowerShell helper (ADO, Search.CollatorDSO): the
 * process and its connection stay open, so a search takes milliseconds instead of the seconds a
 * new PowerShell and a cold connection need. It only runs SELECT queries Keo builds itself, and
 * closes after a while without searches.
 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$conn = $null
function Open() {
  $c = New-Object -ComObject ADODB.Connection
  $c.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
  return $c
}
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $req = ConvertFrom-Json $line
  try {
    if (-not $conn) { $conn = Open }
    if ($req.sql -eq 'warm') { $out = @{ id = $req.id; ok = $true; rows = @() } }
    else {
      if (-not ([string]$req.sql).StartsWith('SELECT ')) { throw 'only SELECT' }
      $rs = $conn.Execute([string]$req.sql)
      $rows = New-Object System.Collections.ArrayList
      while (-not $rs.EOF) {
        $f = $rs.Fields
        $m = $f.Item('System.DateModified').Value
        $s = $f.Item('System.Size').Value
        # The index gives times in UTC.
        [void]$rows.Add(@{ p = [string]$f.Item('System.ItemPathDisplay').Value; t = [string]$f.Item('System.ItemType').Value; s = $(if ($s -ne $null -and $s -isnot [DBNull]) { [double]$s } else { $null }); m = $(if ($m -ne $null -and $m -isnot [DBNull]) { ([DateTime]$m).ToString('yyyy-MM-ddTHH:mm:ssZ') } else { $null }) })
        $rs.MoveNext()
      }
      $rs.Close()
      $out = @{ id = $req.id; ok = $true; rows = @($rows) }
    }
  } catch {
    $conn = $null
    $out = @{ id = $req.id; ok = $false; error = [string]$_.Exception.Message }
  }
  [Console]::Out.WriteLine((ConvertTo-Json $out -Compress -Depth 4))
  [Console]::Out.Flush()
}
`;

type Pending = { resolve: (rows: IndexRow[]) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class WindowsSearchIndex implements IndexBackend {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private seq = 0;
  private pending = new Map<number, Pending>();
  private idle: NodeJS.Timeout | null = null;
  /** Set once the index answered "not available" (service off): no more attempts this run. */
  private broken: string | null = null;

  constructor(private readonly opts: { idleMs?: number } = {}) {}

  warm(): void {
    void this.query('warm', new AbortController().signal).catch(() => undefined);
  }

  query(sql: string, signal: AbortSignal): Promise<IndexRow[]> {
    if (process.platform !== 'win32') return Promise.reject(new IndexUnavailable('Windows Search is only on Windows.'));
    if (this.broken) return Promise.reject(new IndexUnavailable(this.broken));
    const proc = this.ensure();
    const id = ++this.seq;
    this.touch();
    return new Promise<IndexRow[]>((resolve, reject) => {
      // The first search also starts PowerShell and opens the index (a few seconds when cold).
      const timer = setTimeout(() => this.settle(id, new IndexUnavailable('Windows Search did not answer in time.')), this.pending.size || this.seq > 1 ? 8000 : 15000);
      this.pending.set(id, { resolve, reject, timer });
      signal.addEventListener('abort', () => this.settle(id, new Error('cancelled')), { once: true });
      proc.stdin.write(`${JSON.stringify({ id, sql })}\n`);
    });
  }

  close(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const p = this.proc;
    this.proc = null;
    p?.stdin.end();
    p?.kill();
    for (const id of [...this.pending.keys()]) this.settle(id, new IndexUnavailable('closed'));
  }

  private settle(id: number, err: Error | null, rows?: IndexRow[]): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (err) p.reject(err);
    else p.resolve(rows ?? []);
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), this.opts.idleMs ?? 15 * 60_000);
    this.idle.unref?.();
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc;
    const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
    const proc = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        try {
          const m = JSON.parse(line) as { id: number; ok: boolean; rows?: Array<{ p: string; t: string; s: number | null; m: string | null }> | { p: string } ; error?: string };
          if (!m.ok) {
            const msg = m.error ?? 'Windows Search failed.';
            // Provider missing / service stopped: the index cannot be used on this PC right now.
            if (/provider|class not registered|0x80040154|service|not running|cannot be found/i.test(msg)) this.broken = 'Windows Search is not available on this PC.';
            this.settle(m.id, new IndexUnavailable(msg));
            continue;
          }
          // PowerShell 5 writes a one-row array as a bare object.
          const raw = Array.isArray(m.rows) ? m.rows : m.rows ? [m.rows as { p: string; t: string; s: number | null; m: string | null }] : [];
          this.settle(
            m.id,
            null,
            raw.filter((r) => r.p).map((r) => ({ path: r.p, isFolder: r.t === 'Directory', size: typeof r.s === 'number' ? r.s : null, modified: r.m })),
          );
        } catch {
          /* not one of ours */
        }
      }
    });
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = null;
      for (const id of [...this.pending.keys()]) this.settle(id, new IndexUnavailable('The Windows Search helper stopped.'));
    });
    proc.on('error', () => {
      this.broken = 'PowerShell could not start.';
    });
    this.proc = proc;
    return proc;
  }
}
