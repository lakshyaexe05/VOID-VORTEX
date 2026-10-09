# CampusIQ local backend setup

This adds a local pilot backend to the prototype. It stores demo/imported student-term rows, courses, attendance, assignments, submissions, grades, and follow-up cases in SQLite, requires sign-in, and enforces role-based access in the API. The server binds only to `127.0.0.1`.

## Requirements

- Node.js 24 or later (uses the built-in `node:sqlite` module; no package install is needed). The PowerShell scripts also look for the Codex-bundled Node runtime if `node` is not on PATH.
- Windows PowerShell.

## First-time setup

1. Extract the dashboard ZIP to a folder you can write to. The SQLite file is created in a `data` folder the first time the server runs; it is intentionally not included in the ZIP.
2. Open PowerShell in the extracted `outputs` folder.
3. Create the first administrator account:

   ```powershell
   .\create-user.ps1 -Username campus-admin -Role admin -DisplayName "Campus Administrator"
   ```

   Enter a unique password of at least 12 characters when prompted. Passwords are stored as scrypt hashes; the password is not saved in the script or database as plain text.

4. Start the server:

   ```powershell
   .\start-campusiq.ps1
   ```

5. Open the address printed by the server in your browser and sign in. It uses port 4173 by default and automatically tries the next port if 4173 is already occupied. The initial database is seeded from `demo-data.csv` with synthetic records.

## Faculty accounts and student assignment

Create a faculty account using the same secure prompt:

```powershell
.\create-user.ps1 -Username faculty-one -Role faculty -DisplayName "Faculty One"
```

An administrator can assign a student ID to that faculty account from PowerShell:

```powershell
$env:CAMPUSIQ_ASSIGN_STUDENT = "STU-0001"
node .\server.js assign $env:CAMPUSIQ_ASSIGN_STUDENT faculty-one
Remove-Item Env:CAMPUSIQ_ASSIGN_STUDENT
```

Repeat for each student assignment. Faculty accounts see only assigned student records and their follow-up cases. Only administrators can import or export the full cohort, access data-quality/import controls, or manage assignments. The signed-in account controls access; users cannot change their role in the dashboard.

## Student accounts and student portal

Create a student account linked to a student ID in the cohort:

```powershell
.\create-user.ps1 -Username student-0001 -Role student -StudentId STU-0001 -DisplayName "Student One"
```

Student sign-in opens a personal progress page. The student API response contains only that student's term records; it does not return cohort data, other student profiles, staff interventions, data import/export tools, or score settings. Create a separate account for each student and link the correct ID.

## Using teaching features

After the administrator signs in, use **Accounts & access** to create faculty and student accounts and disable accounts when needed. Use **Classes & attendance** to create a class, select its faculty member, and enter the enrolled student IDs. The prototype checks faculty and student timetable overlaps.

Faculty sign in with their own accounts, select **Classes & attendance**, choose the class date, mark each enrolled student Present, Absent, or Late, and save. Student portals refresh campus information every 15 seconds and show their own timetable and attendance report.

Faculty can publish coursework from **Assignments** with instructions, due date, and points. Students can submit a text response or one file up to 5 MB; faculty can grade submissions and return feedback. Assignment submissions and grades are visible only to the student and authorized class staff. Notification categories can be toggled per account in that browser.

Students can ask staff to correct a recorded attendance entry from their **Attendance** section. Requests include the class date, requested status, and reason; the assigned faculty member or administrator can approve or decline them, and approval updates the attendance record. Students can also send private requests from **Support**; authorized staff can change the request status and reply. Faculty and administrators can post class announcements or cancellations from **Updates**, categorized as General, Exam, Assignment, Deadline, Room change, Timetable, Study material, Event, Holiday, or Emergency. They can also edit a course day, time, or room from **Timetable**. Timetable edits automatically create a student-facing update. Campus changes appear on signed-in pages during the 15-second refresh.

These are local prototype workflows. They do not send email, SMS, or operating-system push notifications, and uploaded files are stored in the local SQLite database. Back up `data/campusiq.sqlite`; do not use real student records until the institution approves security, privacy, hosting, retention, and backup arrangements.

## Storage and limitations

- Imported cohorts and cases persist in `data/campusiq.sqlite` on this computer. Imported cohort replacement occurs only after the server accepts valid CSV rows.
- Sessions expire after eight hours and are held in memory; restarting the server signs users out.
- The API writes audit entries for sign-in/out, imports, student-list access, case updates, and assignment changes.
- This local server is for a controlled prototype only. It uses HTTP on loopback and does not provide TLS, managed backups, institutional identity, a formal security review, or a production deployment. Do not expose it to the network or use real student records until the college approves hosting, privacy, security, access, retention, and incident-response controls.
- The prototype still uses transparent score thresholds, not a trained prediction model. The assistant is local and rule-based, not a connected generative AI service. SIS/LMS integrations need approved APIs and credentials.

## Standalone demo

Opening `index.html` directly with `file://` keeps the original standalone synthetic-data demo. Sign-in, persistent backend data, and server-side role checks require starting the local server and opening its `http://127.0.0.1:4173` address.
