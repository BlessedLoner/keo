/**
 * What Keo does when one of its windows' pages stops (a crash, or Windows ending it): reload it,
 * but not over and over: after `max` stops within `windowMs` it gives up (the user is told to
 * restart Keo, so a page that crashes on load cannot loop forever).
 */
export class CrashGuard {
  private stops: number[] = [];

  constructor(
    private readonly max = 3,
    private readonly windowMs = 10 * 60_000,
  ) {}

  /** A page stopped at `now`: 'reload' it, 'ignore' a normal close, or 'give-up'. */
  gone(reason: string, now = Date.now()): 'reload' | 'ignore' | 'give-up' {
    if (reason === 'clean-exit') return 'ignore';
    this.stops = this.stops.filter((t) => now - t < this.windowMs);
    if (this.stops.length >= this.max) return 'give-up';
    this.stops.push(now);
    return 'reload';
  }
}
