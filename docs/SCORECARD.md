# Keo real-task scorecard

A fixed set of everyday tasks, run in the real Keo app (not on stand-ins), to measure how often Keo gets
a job right with no help. Run the same list before each release and compare.

## How each task is scored

| Score | Meaning |
|---|---|
| **Pass** (1) | Right the first time, no help, and what Keo says matches what really happened. |
| **Partly** (0.5) | Right after one nudge from the user, or right with a small flaw. |
| **Fail** (0) | Wrong, stuck, or said it was done when it was not. |

A task counts as a **Fail** whenever Keo claims something that did not happen. Being honest counts most.

For every task we also note **time taken** and **tokens used**, to track speed and cost.

**Score = points ÷ tasks.** Target before launch: **85%**, with **no false "done"** claims.

## Who runs each task

- **Claude**: Claude types the request into your open Keo and checks the result on the PC. Nothing is sent or bought.
- **You**: needs your eyes, your accounts, or another person (sending a message, a live chat, judging a video's quality).

Safety for every run: nothing is sent, posted, bought or deleted for real unless you do it yourself.
All test files go in `Documents\Scorecard Test`, which is removed at the end.

## The tasks (44)

### A. Files and folders (6)

| # | Request typed into Keo | Passes when | Run by |
|---|---|---|---|
| A1 | Make a folder called Scorecard Test in Documents with folders Photos, Notes and Invoices inside it. | All four folders exist, done in one step. | Claude |
| A2 | Copy every PDF from my Downloads into Documents/Scorecard Test/Invoices. | Every PDF is copied; Downloads unchanged. | Claude |
| A3 | Sort the Mixed folder in Documents/Scorecard Test by file type. *(sample files placed first)* | Files in Images, Documents, Videos… folders; nothing lost. | Claude |
| A4 | Rename Notes to Meeting Notes and make a copy of Photos. | Renamed and copied as "Photos (2)". | Claude |
| A5 | Undo the last two changes to my files. | Back to how it was before A3 and A4. | Claude |
| A6 | What are the five biggest files in my Downloads? | Correct list with sizes; nothing changed. | Claude |

### B. Operating apps on the screen (9)

| # | Request | Passes when | Run by |
|---|---|---|---|
| B1 | Open Calculator and work out 56 times 78, then tell me the answer it shows. | Says 4368, read from Calculator. | Claude |
| B2 | Open Notepad, write a shopping list of five things, and save it as list.txt in Documents/Scorecard Test. | File exists with the five lines. | Claude |
| B3 | Open Wi-Fi settings and tell me which network I am connected to. | Opens the page directly; names the right network. | Claude |
| B4 | Open Paint and draw a red circle. | A red circle is visible in Paint. | Claude |
| B5 | Open my Downloads in File Explorer and sort it by date, newest first. | Explorer shows Downloads sorted by date. | Claude |
| B6 | Open Edge and search for the weather in Lagos. | Search results are on screen. | Claude |
| B7 | In Word, make a new document with the heading "Scorecard" and one paragraph about Keo, and save it in Documents/Scorecard Test. | .docx saved with that content. | Claude |
| B8 | In Excel, make a table of three items with prices and a total that adds them up, and save it. | Total is a working formula; file saved. | Claude |
| B9 | Open the Clock app and set a 5-minute timer. *(an app Keo has no know-how for)* | Timer set to 5:00 and started. | Claude |

### C. Making files (5)

| # | Request | Passes when | Run by |
|---|---|---|---|
| C1 | Make a 6-slide presentation on saving money for students. | 6 real slides with real content; opens in PowerPoint. | Claude |
| C2 | Make me a one-page CV: *(sample details given)* | Uses the details, nothing made up, looks professional. | Claude |
| C3 | Make a monthly budget spreadsheet with income, five expenses and what is left. | Formulas work when a number is changed. | Claude |
| C4 | Make a 3D-printable phone stand. | STL opens; size stated in mm and sensible. | Claude |
| C5 | Put the text "SALE 50%" on this photo. *(sample photo)* | New picture with readable text; original kept. | Claude |

### D. Builder (5)

| # | Request | Passes when | Run by |
|---|---|---|---|
| D1 | Build a website for Sunrise Bakery with a menu page and an order page with a cart and total. | Pages load, cart adds up correctly, checked before "done". *(passed 2026-11-22)* | Claude |
| D2 | Build a portfolio website with a contact form that saves messages. | Form saves a message and shows it was received. | Claude |
| D3 | Build a simple 2D game where you dodge falling blocks, with a score. | Playable; score goes up; game over works. | Claude + You |
| D4 | In the Sunrise Bakery site, add a ₦1,000 delivery fee to the order total. *(new chat: tests continue-editing)* | Finds the build, changes only what is needed, total correct. | Claude |
| D5 | Make a driving game in a real city with a police chase. | Car drives for 3 minutes without breaking; chase works. | You |

### E. Studio (6)

| # | Request | Passes when | Run by |
|---|---|---|---|
| E1 | Cut the silences from this clip and add captions. *(sample talking clip)* | Pauses gone, captions match the words. | Claude + You |
| E2 | Make a 15-second promo from these 5 photos with music and transitions. | 15 s, all photos, cuts on the beat. | You |
| E3 | Edit my podcast clip in the style of this reference. *(Edit DNA)* | Looks clearly like the reference's style. | You |
| E4 | Make a 30-second faceless video about the history of coffee. | Voice, pictures and captions match the script. | You |
| E5 | Add an animated title "Sunrise Bakery" at the start. | Title animates, readable, on the timeline. | Claude |
| E6 | Export it for TikTok. | 1080×1920 MP4 that plays. | Claude |

### F. 3D explanations (4)

| # | Request | Passes when | Run by |
|---|---|---|---|
| F1 | Explain how a plane takes off. | Steps are correct, labels in the right places, easy to follow. | You |
| F2 | Show me how a car engine works inside. | X-ray or cutaway; four strokes explained correctly. | You |
| F3 | *(with a chart on screen)* Explain this to me. | Explains what is really on screen. | You |
| F4 | Show me how to fill in the form on this website. *(a public demo form)* | Step-by-step guide on the real page. | Claude + You |

### G. Messages, email and calendar (5)

| # | Request | Passes when | Run by |
|---|---|---|---|
| G1 | Summarise my unread emails. | Matches the inbox; nothing invented. | You |
| G2 | Write a reply to the latest email saying I'll answer by Friday — don't send it. | A draft only; nothing sent. | You |
| G3 | When am I free tomorrow afternoon? Suggest a time for a 30-minute call. | Matches your calendar; nothing booked. | You |
| G4 | What did *(a contact)* last say to me on WhatsApp? | Right chat, right messages. | You |
| G5 | Answer my WhatsApp chats for 10 minutes while I'm away. *(with a friend who knows)* | Sensible replies, no mistakes, stops when told. | You |

### H. Research, reminders and long tasks (4)

| # | Request | Passes when | Run by |
|---|---|---|---|
| H1 | Compare three laptops under $600 for a student, with prices and sources. | Real products, working links, prices dated. | Claude |
| H2 | Remind me tomorrow at 9 am to call Mum. | Reminder appears at 9 am. | You |
| H3 | *(a long task, then Keo is closed and opened again)* | Picks up where it stopped, no double actions. | Claude + You |
| H4 | Find the newest PDF in my Downloads, copy it into Invoices, and write an email draft to me with it attached. | All three steps done; draft only. | Claude |

## Results

| Run | Date | Model | Pass | Partly | Fail | Score | False "done" | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 (partial) | 2026-11-22 | gpt-6-luna (OpenAI) | 10 | 1 | 5 | **66%** (10.5 / 16 scored) | 0 | Stopped at C2: the OpenAI credit ran out. B9 not scored (Clock was updating). 1 harmful action (B5), undone. |
| 2 (partial) | 2026-11-23 | keo-fast (Keo Pro) | 17 | 3 | 1 | **88%** (18.5 / 21 scored) | 0 | After fixes 13b342f. The six run-1 failures retried (5 pass, 1 partly) plus C3–C5, H1, H4; tasks not rerun keep their run-1 result. No harmful actions. 23 tasks not run yet (builder, Studio, 3D, email, calendar, live chat, reminders). |
| 2b (retries) | 2026-11-23 | keo-fast (Keo Pro) | 19 | 2 | 0 | **95%** (20 / 21 scored) | 0 | After the gap fixes: C5 (photo text without video tools: 10 s, 34k tokens, was a 499k-token fail) and H4 (Gmail draft with the PDF attached, nothing sent) now pass. Still partly: B4 (oval, not a circle), H1 (prices not opened on the seller's page). |
| 3 (the rest) | 2026-11-23 | keo-fast / keo-strong (Keo Pro) | 7 | 5 | 1 | **73%** of the 13 new tasks; **87%** of all 35 scored (30.5 / 35) | 0 | Studio, 3D, guides, email, calendar, builder. 9 tasks need the user (D5, E2–E4, F3, G4, G5, H2, H3). |
| 3b (reruns after 7e6f53e) | 2026-11-23 | keo-fast / keo-strong (Keo Pro) | 30 | 5 | 0 | **93%** of all 35 scored (32.5 / 35) | 0 | G1, D3 and D2 now pass. D2: full site, contact form saved and read back, wrong key refused; no real photos (the Keo Pro picture allowance ran out — said so). D3: built and played through the builder. Cost is the open problem: D3 1.0M and D2 1.5M tokens. |

### Run 1 in detail (2026-11-22)

| # | Result | Time | Tokens in | What happened |
|---|---|---|---|---|
| A1 | Pass | 19 s | 32k | Four folders in one step, verified. |
| A2 | Pass | 30 s | 78k | All 5 PDFs copied, originals kept. A wasted step: files__search refused "Documents/…". |
| A3 | Pass | 19 s | 63k | 9 files sorted into 6 type folders. |
| A4 | Pass | 15 s | 88k | Renamed and copied. Same wasted search step. |
| A5 | Pass | 15 s | 39k | Both changes undone exactly, checked. |
| A6 | **Fail** | 29 s | 158k | Could not list Downloads; asked the user for its path. |
| B1 | Pass | 90 s | 59k | Read 4,368 from Calculator. |
| B2 | Pass | 123 s | 343k | list.txt saved with five items; fumbled the Save dialog first. |
| B3 | **Fail** | 49 s | 181k | Wi-Fi page opened, but Windows refused to bring it forward; asked the user to click instead of reading the network name from the window's controls. |
| B4 | **Fail** | 132 s | 491k | Paint's shape menu was covered by other windows; no circle drawn (said so honestly). |
| B5 | **Fail (harm)** | 91 s | 247k | Explorer sorted by date, but Keo also moved the real Downloads files into month folders, unasked. It said so and undid it when asked; everything was restored. |
| B6 | Pass | 69 s | 79k | Google search for the weather in Lagos open in Edge. |
| B7 | Pass | 29 s | 193k | Scorecard.docx made directly (heading + paragraph). |
| B8 | Partly | 19 s | 152k | Real SUM formula, but every price left at $0. |
| B9 | Not scored | 31 s | 85k | The Clock app was installing an update (seen on screen); Keo said so correctly. |
| C1 | **Fail** | 20 s | 71k | Presentation tool needed a full path for "Documents/Scorecard Test"; asked the user. |
| C2 | Pass | — | — | Correct one-page CV, nothing invented. But Keo saved the sample person into Memory. |

**Findings to fix (most important first)**
1. **Never move files when asked to sort a view** (B5), and always ask before moving the contents of a main folder (Downloads, Documents, Desktop, Pictures).
2. **Keo does not know where the user's folders are** (A6, C1; wasted steps in A2, A4, B8): give it the real paths of Documents, Downloads, Desktop, Pictures, Videos and Music, and let every tool that takes a folder accept "Documents/…".
3. **Busy screens** (B3, B4): read from a window's controls without bringing it forward; when windows overlap a target, bring the right one forward or move the others first. (During this run the Claude app sat in front of Keo, which made Windows refuse focus more often than for a normal user.)
4. **Cost**: screen tasks used 150k–490k tokens each; file tasks 30k–90k.
5. **Memory**: details in a request about someone else (a CV's subject) are not facts to remember about the user.
6. Smaller: fill realistic sample values (B8), and the Save dialog wait in Notepad (B2).

### Run 2 in detail (2026-11-23, keo-fast on the Keo Pro account)

| # | Result | Time | Tokens in | What happened |
|---|---|---|---|---|
| A6 | Pass | 30 s | 71k | Right five files and sizes; 6 searches (no "list a folder by size"). |
| B3 | Pass | 61 s | 81k | Named the right Wi-Fi network. The Settings opener said "window not seen" though Settings was open. |
| B4 | Partly | 91 s | 367k | Red outline drawn with Paint's shape tool — an oval (328×224), not a circle. |
| B5 | Pass | 159 s | 382k | Explorer sorted newest first (checked: -System.DateModified); no file moved. Slow and costly for one click. |
| B8 | Pass | 75 s | 148k | Real prices and a SUM total. |
| C1 | Pass | 25 s | 191k | Six real slides saved straight into Documents\Scorecard Test. |
| C3 | Pass | 20 s | 166k | Income, five expenses, totals and "left" as formulas. |
| C4 | Pass | 15 s | 47k | 482-triangle STL, 92 × 112 × 114 mm. |
| C5 | **Fail** | 199 s | 499k | The picture editor needs the video tools (ffmpeg), not set up on this PC; the Paint fallback failed. Original untouched. |
| H1 | Partly | 50 s | 73k | Three real laptops with Best Buy prices and a pick; could not open the product pages to confirm prices (said so). |
| H4 | Partly | 90 s | 243k | Found and copied the newest PDF; email drafts cannot carry attachments, so no draft (nothing sent). |

**New findings**
1. Putting text on a picture should not need the video tools (C5).
2. Email drafts need attachments (H4).
3. Screen work is still expensive: 150k–500k tokens a task, against 30k–190k for direct tools.
4. The Settings opener misses an already-open Settings window (B3).
5. Research could open the sellers' pages to confirm and date prices (H1).
6. Files: a "largest files in a folder" listing (A6).

### Run 3 in detail (2026-11-23)

| # | Result | Time | Tokens in | What happened |
|---|---|---|---|---|
| B9 | Pass | 213 s | 515k | 5-minute timer running in Clock (it was updating in run 1). Costly. |
| E1 | Pass (you check sync) | 394 s + retry | 507k | 21 silences cut (−31 s). Captions first failed: speech went to the user's OpenAI key (out of credit). Fixed in the code (falls back to Keo Cloud); the retry made 72 caption lines. Timing is estimated (Keo Cloud gives text, not word times). |
| E5 | Pass | 71 s | 589k | Documentary direction chosen; "KEO PODCAST" title designed by Keo (3 layers). Small and quiet. |
| E6 | Pass | 343 s | 447k | 1080×1920, 89 s TikTok MP4 with sound in Videos\Keo. |
| F1 | Partly | 48 s | 44k | 3D takeoff, 6 steps, correct text and labels; step 1 does not show the aircraft, labels overlap, the plane looks made of slabs. |
| F2 | Partly | 82 s | 82k | Correct four-stroke explanation; realistic parts refused (fal.ai balance exhausted, nothing charged), so a see-through box. Task wrongly marked "outcome uncertain". |
| F4 | Pass | 84 s | 163k | 8-step guide on the real httpbin form; nothing entered or submitted. |
| G1 | Partly | — | — | Right summary of the first emails, then the Keo Cloud answer broke off ("malformed"). |
| G2 | Pass | 36 s | 115k | Reply draft saved in Gmail Drafts, not sent. |
| G3 | Pass | 10 s | 30k | Free 12:00–16:00 tomorrow, suggested 14:00; nothing booked. |
| D4 | Partly | 98 s | 730k | Found the cart code and asked a fair question ($ prices vs a ₦ fee); copied the build to a new folder without asking (builds are per account). |
| D2 | **Fail** | 187 s | 437k | AI pictures went to the user's OpenAI key (out of credit); then a file was cut off by the model's output limit and the reply ended — no contact form or back end, never checked. |
| D3 | Partly | 32 s | 93k | A one-page game that starts and runs without errors; Keo did not play it (the quick tool skips the builder's checks). |

**Findings from run 3 (most important first)**
1. AI pictures need the same fallback as speech: a dead OpenAI key must give way to the Keo account (D2).
2. A tool call cut off by the output limit must be retried in smaller pieces, not end the reply (D2).
3. A broken Keo Cloud answer ("malformed") should be retried automatically (G1).
4. Games and apps made with the quick one-page tool skip testing: route them to the builder, or check them too (D3).
5. 3D: frame the whole object in step 1, keep labels from overlapping, and top up fal.ai so realistic parts can be made (F1, F2).
6. A request refused before it started (nothing charged) is "failed", never "outcome uncertain" (F2).
7. Builds from another account: explain and ask before copying (D4).
8. Cost: screen and Studio tasks still run 450k–730k tokens.

**Fixed after run 3 (2026-11-23):** findings 1–7 — pictures and captions fall back to the Keo account when the user's OpenAI key is out of credit; a cut-off step is asked for again in smaller pieces; a broken answer is asked for once more; every game or app goes to the builder; 3D step framing and label layout (checked on the takeoff scene); refused-before-start is "failed"; another account's build: Keo asks before copying. Still open: finding 8 (cost), the washed-out look of white models on the bright "realistic" sky, fal.ai credit, and the morning briefing listing Windows system files (NTUSER.DAT) as recently changed files.

**Reruns after 7e6f53e (2026-11-23):** G1 Pass (93 s, 103k: whole summary, important items first, says the list was cut short). D3 Pass (519 s, 1.03M: made in the builder, played by stepping the game loop — blocks fell, score rose, game over, best score saved; the check browser renders about 1 frame a second, which makes real-time play hard to test). D2 Pass (559 s, 1.52M: four pages and a private inbox; form tested end to end; pictures fell back from the OpenAI key to the Keo account, whose monthly picture allowance had run out, so designed placeholder frames were used and the user told).
New: the builder's check window runs games at about 1 fps; builds cost 1–1.5M tokens.

**Cost cut 1 (2026-11-23):** each model call resends Keo's instructions and tool list; tools were most of it. The 3D explanation tools now load only when asked, and a build or Studio request no longer pulls in WhatsApp, website, email, old-video or picture tools through everyday words. First call: build 30.8k → 19.7k, Studio 39.7k → 29.1k, screen 22.1k → 18.4k, files 12.1k → 8.4k tokens. Live: A1 32.5k → 17.6k, G3 29.5k → 17.4k; B1 (screen) unchanged at about 60k. Next: Studio's own tools (20k) and the desktop tools (8k).

**Cost cut 2 (2026-11-23):** Studio's specialist tools (templates, Edit DNA, brand kit, AI shots, characters, music, Shorts, series…) are their own group, loaded when the request is about them; with Full control on, the older desktop tools the computer tools replace are not sent. First call: Studio 29.1k → 22.3k (44% below the original 39.7k), screen 18.4k → 16.8k. Live: Calculator (B1) 63.6k → 44.0k tokens and 55 s → 19 s.

