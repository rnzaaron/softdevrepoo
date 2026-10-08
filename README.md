# St. Catherine Academic System

A local, multi-page academic management MVP for St. Catherine College of Valenzuela City. The Express server serves plain HTML, CSS, and JavaScript pages; MongoDB is the only database.

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

- `index.html` signs in and stores the local session token in browser storage.
- `dashboard.html` loads live, role-scoped counts, grades, schedules, announcements, and notifications.
- `admin.html` manages users and school records, grading weights, teacher assignments, schedule generation, and absence/substitute actions.
- `grades.html` uses the locally installed ExcelJS browser library to read Excel `.xlsx` files, previews and validates rows through the API, and supports teacher submission and adviser review/finalization. The first sheet needs `StudentID` and the configured component headings, initially `Quiz`, `Exam`, and `Project`. Select the grading period separately: `Prelim`, `Midterm`, or `Final`.
- `schedule.html` displays each student's/parent's own section schedule and a teacher's own teaching/substitute schedule. Admins can also add classes, generate schedules from assignments, and assign substitutes.
- `reports.html` displays generated report cards. Admin/adviser email actions write to MongoDB's local demo email inbox (`email_records`) instead of requiring external credentials.
- `announcements.html` supports school-wide, role, section, and individual-user targeting.
- `requests.html` lets students/parents request documents and staff update request statuses.
- `app.js` contains the MongoDB connection, first-run seed, role checks, data validation, grade calculation, scheduling/conflict checks, substitutions, CRUD APIs, and report/email records.
- `common.js` contains shared navigation, API requests, responsive styles, and HTML escaping.