# St. Catherine Academic System

A local, multi-page academic management MVP for St. Catherine College of Valenzuela City. The Express server serves the browser-side HTML, CSS, and JavaScript from `public/`; MongoDB is the only database.

## Run locally

1. Install Node.js 18+ and MongoDB Community Server. Start the local MongoDB service.
2. In this folder, run `npm install`.
3. Run `npm start` and open `http://localhost:3000`.

The default MongoDB URL is `mongodb://127.0.0.1:27017` and the database is `st_catherine_academic`. Set `MONGODB_URI`, `MONGODB_DB`, or `PORT` before starting to override them. The server prints a connection error and does not start if MongoDB is unavailable.

On an empty database, the first startup seeds sections, students, parent/teacher/admin accounts, subjects, rooms, assignments, a sample announcement, formula configuration, a working weekly schedule, one absent and several present classes, pending/finalized grade samples, and digital report cards. Every demo account uses `pass123`:

| Role | Email |
| --- | --- |
| Admin | `admin@sccvalenzuela.edu.ph` |
| Adviser | `adviser@sccvalenzuela.edu.ph` |
| Teacher | `reyes@sccvalenzuela.edu.ph` |
| Teacher | `cruz@sccvalenzuela.edu.ph` |
| Student | `juan@sccvalenzuela.edu.ph` |
| Parent | `parent@sccvalenzuela.edu.ph` |

## Pages and workflows

- `public/index.html` signs in and stores the local session token in browser storage.
- `public/dashboard.html` loads live, role-scoped counts, grades, schedules, announcements, and notifications.
- `public/admin.html` manages users and school records, grading weights, teacher assignments, schedule generation, and absence/substitute actions.
- `public/grades.html` uses the locally installed ExcelJS browser library to read Excel `.xlsx` files, previews and validates rows through the API, and supports teacher submission and adviser review/finalization. The first sheet needs `StudentID` and the configured component headings, initially `Quiz`, `Exam`, and `Project`. Select the grading period separately: `Prelim`, `Midterm`, or `Final`.
- `public/schedule.html` displays each student's/parent's own section schedule and a teacher's own teaching/substitute schedule. Admins can also add classes, generate schedules from assignments, and assign substitutes.
- `public/reports.html` displays generated report cards. Admin/adviser email actions write to MongoDB's local demo email inbox (`email_records`) instead of requiring external credentials.
- `public/announcements.html` supports school-wide, role, section, and individual-user targeting.
- `public/requests.html` lets students/parents request documents and staff update request statuses.
- `app.js` contains the MongoDB connection, first-run seed, role checks, data validation, grade calculation, scheduling/conflict checks, substitutions, CRUD APIs, and report/email records. `server.js` is the compatibility entry point.
- `public/common.js` contains shared navigation, API requests, responsive styles, and HTML escaping.

## Plain-language guide to the files

Think of this website like a school office:

- The files in `public/` are the pages people see and use in their browser.
- `app.js` is the office staff member who receives each request, checks permissions, and reads or saves the information.
- MongoDB is the filing cabinet that keeps the information after a page is closed.
- A request beginning with `/api/` is a message from a page to the server. The page does not talk to the database directly.

### What each project file does

| File | In everyday words |
| --- | --- |
| `server.js` | The start button. It loads `app.js`, where the real server work happens. |
| `app.js` | The backend: serves the website, connects to MongoDB, checks accounts and roles, and handles grades, reports, announcements, requests, schedules, and school records. |
| `public/index.html` | The sign-in page. It sends the entered email and password to `/api/login`; the server replies with the account details and a sign-in token. |
| `public/dashboard.html` | The landing page after sign-in. It asks for a summary and shows only the information the current role is allowed to see. |
| `public/admin.html` | The administrator's school-record workspace. It adds, edits, lists, and deletes records and saves grading and timetable settings. |
| `public/grades.html` | The grade workflow. Teachers load an Excel file and preview it; the server checks it, calculates weighted grades, and staff review, approve, and release the results. |
| `public/schedule.html` | Shows role-appropriate classes. Administrators can add or generate schedules; authorized staff can request substitute coverage. |
| `public/announcements.html` | Shows notices intended for the signed-in person and lets permitted staff post notices to selected audiences. |
| `public/reports.html` | Shows report cards made from finalized grades. Its email button records a simulated delivery in MongoDB; it does not send a real email. |
| `public/requests.html` | Lets students and parents request documents and lets staff update each request's status. |
| `public/common.js` | Shared browser helpers: page styling, the signed-in user, the `/api/` request helper, safe text display, the menu, and sign-out. |
| `.env` | Private local settings such as the database address and port. Keep real credentials private; do not paste them into messages or publish them. |
| `package.json` | Project name and instructions for npm. `start` starts the site, `check` checks JavaScript syntax, and `dev` starts it with automatic restart during development. It also lists required packages. |
| `package-lock.json` | npm's exact dependency record, so installs use compatible package versions. It is generated by npm and should not be manually annotated. |
| `node_modules/` | Downloaded code used by the project. It is installed by npm and normally should not be edited by hand. |
| `README.md` | These setup instructions and the beginner-friendly explanation. |

JSON files such as `package.json` and `package-lock.json` do not support comments: inserting `//` or `/* ... */` would make npm unable to read them. Their explanation is kept here instead. The `.git/` folder is Git's private bookkeeping, not part of the website; files inside it are generated/managed by Git and should not be edited as application files.

### How the main features work

- **Sign-in:** The browser sends the credentials to the backend. The backend looks up the matching account and returns a random token. The browser stores that token so later requests can identify the signed-in account.
- **Role-based access:** Each protected backend route checks the token and, where needed, the account's role. The server also filters the records it returns. Hiding a button on a page is not the only permission check.
- **Grades:** A teacher's spreadsheet is previewed in the browser, then sent to the backend. The backend checks that the student belongs to the selected class, verifies every score, applies the configured component weights, and stores the submission. The adviser can request a correction or approve it; finalizing publishes the grades and creates report cards.
- **Schedules:** The backend checks whether a proposed class overlaps an existing class for the same room, teacher, or section. Automatic generation chooses available days and time slots. Substitute assignment looks for an available teacher and records notifications.
- **Announcements and requests:** Notices can target the whole school or a role, section, or account. Students and parents can submit document requests; authorized staff can update their progress.
- **Reports and email demo:** Reports use released grades. The send action creates an email record in the local demo inbox, rather than contacting an email service.
- **Startup and sample data:** The backend loads `.env`, connects to MongoDB, and seeds demo data only if the database has no users. The website begins listening after the database connection succeeds.

### A few bits of code syntax, in plain language

- `const name = ...` gives a value a readable name; `const` means that name will not be reassigned. `let` is used when the name needs to point to a new value later.
- `{ name: value }` is an object: a small bundle of labelled information. `[one, two]` is an array: an ordered list.
- `function save() { ... }` names a reusable set of steps. `() => ...` is a shorter way to write a small function.
- `async` and `await` are used when work takes time, such as asking MongoDB or the server. `await` means “wait for this answer before continuing.”
- `app.get(...)`, `app.post(...)`, `app.put(...)`, and `app.delete(...)` are server routes. In everyday terms they read, create, change, and remove information. `:id` in a route is a slot for a particular record's ID.
- `req` means the incoming request; `res` means the reply. `res.json(...)` sends structured data back to the browser.
- `if (...)` chooses what to do based on a condition. `&&` means “and”; `||` means “or / otherwise”; `!` means “not.”
- Backticks make a template string. `${value}` inserts a value into that text, which is how the pages build tables and messages from live records.
- `?.` safely checks an optional value before reading from it; `??` uses a fallback only when the value is missing (`null` or `undefined`).
- `try { ... } catch (error) { ... }` handles a problem and lets the page or server show an error instead of silently pretending it worked.
- `document.getElementById(...)` finds a named spot on the page. Assigning its `textContent` changes visible text; `innerHTML` builds page markup, so values inserted there are passed through `esc(...)` first.
- `//` starts a JavaScript comment and `<!-- ... -->` is an HTML comment. Comments explain the code to people and are not displayed as part of the page.
- HTML tags such as `<main>`, `<form>`, and `<button>` describe page parts. An `id="box"` gives a part a name so JavaScript can find and update it.
- CSS rules such as `.card { ... }` set appearance: `.card` selects things with that class, while `#nav` selects the one thing named `nav`. `@media (max-width: 760px)` applies different layout rules on narrow screens.
- In browser code, `addEventListener` or an HTML `onclick="..."` connects a user action to a function. For example, submitting a form calls JavaScript, which sends the request to `/api/...`.
- Array helpers such as `.map(...)` turn each item into something new (often a table row), `.filter(...)` keeps matching items, and `.join('')` combines pieces of text.
- `try/catch` does not hide errors here: pages display a useful message, and the backend logs unexpected route failures. The browser helper also rejects responses that are empty or not valid JSON.