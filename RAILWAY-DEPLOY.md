# Deploy CampusIQ to Railway

This guide publishes the synthetic CampusIQ prototype from GitHub using a Railway Node.js service and a persistent volume for SQLite. The deployment is intended for a hackathon demo, not real student records.

## Before connecting Railway

1. Make sure `outputs/data/campusiq.sqlite` and `outputs/demo-data.csv` are in the GitHub repository. The SQLite file is the synthetic demo snapshot and supplies the preloaded cohort, courses, and enrollments.
2. The bundled database contains synthetic demo accounts and preloaded courses/enrollments. Keep the SQLite snapshot if you want those same examples in the role views.

## Create the Railway service

1. Push the project folder to a GitHub repository, then create a Railway project from that GitHub repository.
2. Set **Root Directory** based on how files appear in your GitHub repository. If the files are inside an `outputs` folder, set it to `outputs`; if you uploaded the contents of `outputs` directly into the repository root (as in the current VOID-VORTEX repo), leave **Root Directory** blank. Leave the build command blank and set **Start Command** to:

   ```text
   npm start
   ```

   `package.json` declares Node.js 24 or newer and starts `server.js`.

3. Add these service variables:

   | Variable | Value |
   |---|---|
   | `HOST` | `0.0.0.0` |
   | `CAMPUSIQ_DATA_DIR` | `/campusiq-data` |
   | `COOKIE_SECURE` | `true` |

   Railway supplies `PORT` at runtime. Do not set a fixed port in Railway.

4. Add a Railway volume and set its **Mount Path** to `/campusiq-data`. On the first start, if the volume has no `campusiq.sqlite`, CampusIQ copies the bundled `data/campusiq.sqlite` snapshot into it. Later deploys reuse the persistent database so account and class changes remain saved.
5. Deploy the service. In **Settings → Networking**, choose **Generate Domain**. Share the resulting HTTPS URL with evaluators.

## Use the three demo roles

Open the generated HTTPS domain and select **Administrator**, **Faculty**, or **Student** on the role screen. Use **Switch role** in the app to change views. The representative Faculty account has assigned classes, and the Student account is enrolled in the demo timetable. There are no demo passwords to enter.

This is an intentionally open role switcher for judging the synthetic hackathon prototype. Anyone with the URL can open all three roles and perform the actions available in each view. Do not store real student data or credentials in this public demo. For a real pilot, restore authenticated access and complete a security review before sharing it.

## Database and demo limits

- Keep one running app instance when using this SQLite volume. This prototype is not designed for multiple server replicas or high-concurrency production use.
- The volume is the persistent copy after first deployment. Updating the GitHub seed database later does not overwrite an existing volume database. Back up the volume before any manual database replacement.
- This is a public demo: visitors can switch into every role and perform that role's allowed actions. Use synthetic records only; never store personal or college credentials here.
- Public hosting does not make the prototype production-ready. It has no institutional identity provider, formal security review, managed backup policy, or real SIS/LMS integration.

## If the deployment does not start

- Check Railway's deployment logs. Confirm Root Directory is `outputs`, Start Command is `npm start`, and `HOST` is `0.0.0.0`.
- Confirm Railway assigned `PORT` automatically and the volume mount path exactly matches `/campusiq-data`.
- If the site loads but the role chooser reports an error, confirm the synthetic SQLite snapshot was committed before the first deploy and the service has access to the mounted volume.
