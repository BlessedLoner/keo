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
| 1 | | | | | | | | |
