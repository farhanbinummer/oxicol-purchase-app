# Speed: what makes a click slow, and what was done

## What was measured (a phone on a slow connection: 1.6 Mbps, 150 ms delay)
| | Before | After |
|---|---|---|
| Data downloaded on every click (My Day) | about 190 KB | 3 KB on a repeat click, 12 KB on the first |
| Data downloaded for the project page | about 330 KB | about 49 KB |
| Time until a page starts working (My Day) | 1.1 seconds | 0.35 seconds |
| Time until the project page starts working | 1.7 seconds | 0.4 seconds |

The server itself was always quick (every answer under 100 ms on a test machine). The time went on **downloading**: nothing was compressed and nothing was kept, so every click downloaded the styles, the main script and the page again.

## What was changed
1. **Compression:** pages, styles, scripts and server answers are compressed (about 80% smaller).
2. **Keeping files, safely:** the browser keeps pages, styles and scripts but asks the server on every use whether they changed. An unchanged file costs a tiny "not modified" answer; a new version after a deploy is picked up at once, so an old script can never break a page. Pictures and icons are kept for a week. **Data is never kept:** every `/api` answer is sent with `no-store`.
3. **No waiting chain on the project page:** it used to ask for six things one after another; now it asks for them all at once (only for things the person is allowed to open).
4. **Feedback on every click:** a thin progress bar appears at the top the moment a link to another page is clicked, and after a short delay when the app is waiting for the server. Buttons have a pressed look and disabled buttons look disabled. Taps on a phone have no extra delay. All of it respects the "reduce motion" setting.

## The one thing code cannot fix: the free Render plan goes to sleep
Render's free plan puts the app to sleep after about 15 minutes with nobody using it. The next click then waits 30 to 60 seconds while it wakes up. To avoid that, a free outside timer can touch the app every 10 minutes, so it never falls asleep:

1. Create a free account at cron-job.org.
2. Create a job: address `https://oxicol-purchase-app.onrender.com/api/health`, method **GET**, every **10 minutes**.
3. Choose the days and hours you work (for example Monday to Saturday, 06:30 to 21:00) and the time zone **Asia/Kolkata**.
4. Save and turn it on.

(The morning-message jobs described in `docs/NOTICES.md` can use the same account.) The proper fix is a paid Render plan, which never sleeps.
