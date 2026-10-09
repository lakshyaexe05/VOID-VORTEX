#!/usr/bin/env node
// CampusIQ pilot backend. Local runs bind to loopback; hosting platforms can set HOST,
// PORT, CAMPUSIQ_DATA_DIR, and COOKIE_SECURE for a public demo deployment.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const root = path.dirname(fileURLToPath(import.meta.url));
const defaultDataDir = path.join(root, 'data');
const dataDir = path.resolve(process.env.CAMPUSIQ_DATA_DIR || defaultDataDir);
fs.mkdirSync(dataDir, { recursive: true });
const dbFile = path.join(dataDir, 'campusiq.sqlite');
const seedDbFile = path.join(defaultDataDir, 'campusiq.sqlite');
if (path.resolve(dbFile) !== path.resolve(seedDbFile) && !fs.existsSync(dbFile) && fs.existsSync(seedDbFile)) {
  fs.copyFileSync(seedDbFile, dbFile);
  console.log('Initialized persistent database from the bundled synthetic demo database.');
}
const db = new DatabaseSync(dbFile);
db.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS students(student_id TEXT NOT NULL, term TEXT NOT NULL, row_json TEXT NOT NULL, PRIMARY KEY(student_id,term));
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','faculty')), salt BLOB NOT NULL, password_hash BLOB NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS assignments(student_id TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), PRIMARY KEY(student_id,user_id));
CREATE TABLE IF NOT EXISTS student_accounts(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, student_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cases(student_id TEXT PRIMARY KEY, case_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS courses(id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, title TEXT NOT NULL, weekday INTEGER NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, room TEXT NOT NULL DEFAULT '', faculty_id INTEGER NOT NULL REFERENCES users(id), enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS course_enrollments(course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE, student_id TEXT NOT NULL, PRIMARY KEY(course_id,student_id));
CREATE TABLE IF NOT EXISTS class_sessions(id INTEGER PRIMARY KEY, course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE, class_date TEXT NOT NULL, created_at TEXT NOT NULL, created_by INTEGER NOT NULL, UNIQUE(course_id,class_date));
CREATE TABLE IF NOT EXISTS attendance_records(session_id INTEGER NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE, student_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('Present','Absent','Late')), updated_at TEXT NOT NULL, PRIMARY KEY(session_id,student_id));
CREATE TABLE IF NOT EXISTS course_assignments(id INTEGER PRIMARY KEY, course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE, title TEXT NOT NULL, instructions TEXT NOT NULL, due_at TEXT NOT NULL, max_points REAL NOT NULL DEFAULT 100, allow_late INTEGER NOT NULL DEFAULT 0, created_by INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS submissions(id INTEGER PRIMARY KEY, assignment_id INTEGER NOT NULL REFERENCES course_assignments(id) ON DELETE CASCADE, student_id TEXT NOT NULL, answer_text TEXT NOT NULL DEFAULT '', file_name TEXT NOT NULL DEFAULT '', file_type TEXT NOT NULL DEFAULT '', file_data TEXT NOT NULL DEFAULT '', submitted_at TEXT NOT NULL, score REAL, feedback TEXT NOT NULL DEFAULT '', graded_at TEXT, UNIQUE(assignment_id,student_id));
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at TEXT NOT NULL, user_id INTEGER, action TEXT NOT NULL, detail TEXT);
CREATE TABLE IF NOT EXISTS attendance_requests(id INTEGER PRIMARY KEY,course_id INTEGER NOT NULL REFERENCES courses(id),student_id TEXT NOT NULL,class_date TEXT NOT NULL,desired_status TEXT NOT NULL CHECK(desired_status IN ('Present','Absent','Late')),reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Approved','Declined')),created_at TEXT NOT NULL,reviewed_by INTEGER,reviewed_at TEXT,response TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS class_updates(id INTEGER PRIMARY KEY,course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,created_by INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('announcement','cancellation','timetable_change')),title TEXT NOT NULL,message TEXT NOT NULL,applies_on TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS support_requests(id INTEGER PRIMARY KEY,student_id TEXT NOT NULL,category TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'Open' CHECK(status IN ('Open','In progress','Resolved')),created_at TEXT NOT NULL,reviewed_by INTEGER,reviewed_at TEXT,response TEXT NOT NULL DEFAULT '');`);
const submissionColumns=new Set(db.prepare('PRAGMA table_info(submissions)').all().map(c=>c.name));
for(const [column,definition] of [['file_name',"TEXT NOT NULL DEFAULT ''"],['file_type',"TEXT NOT NULL DEFAULT ''"],['file_data',"TEXT NOT NULL DEFAULT ''"]])if(!submissionColumns.has(column))db.exec(`ALTER TABLE submissions ADD COLUMN ${column} ${definition}`);
const assignmentColumns=new Set(db.prepare('PRAGMA table_info(course_assignments)').all().map(c=>c.name));if(!assignmentColumns.has('allow_late'))db.exec('ALTER TABLE course_assignments ADD COLUMN allow_late INTEGER NOT NULL DEFAULT 0');
const courseColumns=new Set(db.prepare('PRAGMA table_info(courses)').all().map(c=>c.name));if(!courseColumns.has('title'))db.exec("ALTER TABLE courses ADD COLUMN title TEXT NOT NULL DEFAULT ''");db.exec("UPDATE courses SET title=code WHERE title=''");
const classUpdateColumns=new Set(db.prepare('PRAGMA table_info(class_updates)').all().map(c=>c.name));if(!classUpdateColumns.has('category'))db.exec("ALTER TABLE class_updates ADD COLUMN category TEXT NOT NULL DEFAULT 'General'");

const statements = {
  userByName: db.prepare('SELECT * FROM users WHERE username=? AND enabled=1'),
  userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
  createUser: db.prepare('INSERT INTO users(username,display_name,role,salt,password_hash) VALUES(?,?,?,?,?)'),
  studentCount: db.prepare('SELECT COUNT(*) AS n FROM students'),
  upsertStudent: db.prepare('INSERT INTO students(student_id,term,row_json) VALUES(?,?,?) ON CONFLICT(student_id,term) DO UPDATE SET row_json=excluded.row_json'),
  allStudents: db.prepare('SELECT row_json FROM students ORDER BY term,student_id'),
  assignedStudents: db.prepare('SELECT s.row_json FROM students s JOIN assignments a ON a.student_id=s.student_id WHERE a.user_id=? ORDER BY s.term,s.student_id'),
  facultyStudents: db.prepare('SELECT s.row_json FROM students s WHERE EXISTS (SELECT 1 FROM assignments a WHERE a.student_id=s.student_id AND a.user_id=?) OR EXISTS (SELECT 1 FROM course_enrollments e JOIN courses c ON c.id=e.course_id WHERE e.student_id=s.student_id AND c.faculty_id=?) ORDER BY s.term,s.student_id'),
  ownStudents: db.prepare('SELECT row_json FROM students WHERE student_id=? ORDER BY term'),
  studentAccount: db.prepare('SELECT student_id FROM student_accounts WHERE user_id=?'),
  allCases: db.prepare('SELECT student_id,case_json FROM cases'),
  assignedCases: db.prepare('SELECT c.student_id,c.case_json FROM cases c JOIN assignments a ON a.student_id=c.student_id WHERE a.user_id=?'),
  upsertCase: db.prepare('INSERT INTO cases(student_id,case_json,updated_at) VALUES(?,?,?) ON CONFLICT(student_id) DO UPDATE SET case_json=excluded.case_json,updated_at=excluded.updated_at'),
  assign: db.prepare('INSERT OR IGNORE INTO assignments(student_id,user_id) VALUES(?,?)'),
  findUserId: db.prepare("SELECT u.id FROM users u WHERE u.username=? AND u.role='faculty' AND u.enabled=1 AND NOT EXISTS (SELECT 1 FROM student_accounts s WHERE s.user_id=u.id)"),
  audit: db.prepare('INSERT INTO audit(at,user_id,action,detail) VALUES(?,?,?,?)'),
};

function parseCsv(text) {
  const rows=[]; let row=[], value='', quoted=false;
  for(let i=0;i<text.length;i++) { const c=text[i];
    if(quoted) { if(c==='"'&&text[i+1]==='"'){value+='"';i++;} else if(c==='"') quoted=false; else value+=c; }
    else if(c==='"') quoted=true; else if(c===','){row.push(value);value='';}
    else if(c==='\n'){row.push(value.replace(/\r$/,''));rows.push(row);row=[];value='';} else value+=c;
  }
  if(value||row.length){row.push(value.replace(/\r$/,''));rows.push(row);}
  if(!rows.length)return[];
  const headers=rows.shift().map(x=>x.trim().toLowerCase());
  return rows.filter(r=>r.some(x=>x.trim())).map(r=>Object.fromEntries(headers.map((h,i)=>[h,(r[i]||'').trim()])));
}
function normalizeCsv(csv) {
  const seen=new Set(),good=[],issues=[];
  parseCsv(csv).forEach((r,index)=>{
    const line=index+2, errors=[];
    r.student_id=(r.student_id||r.id||'').trim(); r.name=(r.name||'').trim(); r.term=(r.term||'').trim();
    if(!r.student_id)errors.push('missing student_id'); if(!r.name)errors.push('missing name'); if(!r.term)errors.push('missing term');
    if(!r.cgpa)errors.push('missing cgpa'); else {r.cgpa=Number(r.cgpa);if(!Number.isFinite(r.cgpa)||r.cgpa<0||r.cgpa>10)errors.push('cgpa must be 0–10');}
    for(const key of ['year','backlogs','attendance','lms','engagement','aptitude','coding','interview','placement_readiness']){
      if(!r[key]){r[key]=null;continue;} r[key]=Number(r[key]);
      if(!Number.isFinite(r[key]))errors.push(`${key} must be numeric`);
      else if(['attendance','lms','engagement','aptitude','coding','interview','placement_readiness'].includes(key)&&(r[key]<0||r[key]>100))errors.push(`${key} must be 0–100`);
      else if(key==='backlogs'&&(!Number.isInteger(r[key])||r[key]<0))errors.push('backlogs must be a non-negative integer');
      else if(key==='year'&&(!Number.isInteger(r[key])||r[key]<1))errors.push('year must be a positive integer');
    }
    if(r.updated_at&&!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(r.updated_at))issues.push(`Row ${line}: updated_at is not ISO 8601`);
    const key=`${r.student_id}|${r.term}`; if(!errors.length&&seen.has(key))errors.push('duplicate student_id and term');
    if(errors.length){issues.push(`Row ${line}: ${errors.join(', ')}`);return;}
    seen.add(key);r.program=(r.program||'').trim()||'Unspecified';
    r.placement=r.placement_readiness!=null?r.placement_readiness:(['aptitude','coding','interview'].every(k=>r[k]!=null)?(r.aptitude+r.coding+r.interview)/3:null);
    good.push(r);
  });
  return {good,issues};
}
function seedDemo() {
  if(statements.userCount.get().n||statements.studentCount.get().n>=2048) return;
  const file=path.join(root,'demo-data.csv'); if(!fs.existsSync(file)) return;
  const {good}=normalizeCsv(fs.readFileSync(file,'utf8'));
  const tx=statements.upsertStudent;
  db.exec('BEGIN'); try { for(const r of good)tx.run(r.student_id,r.term,JSON.stringify(r)); db.exec('COMMIT'); } catch(e){db.exec('ROLLBACK');throw e;}
}
seedDemo();

const sessions=new Map(), attempts=new Map();
const SESSION_MS=8*60*60*1000, MAX_BODY=12*1024*1024;
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.csv':'text/csv; charset=utf-8','.md':'text/markdown; charset=utf-8','.svg':'image/svg+xml'};
const publicFiles=new Set(['index.html','prototype.js']);
function send(res,status,body,headers={}) { const data=typeof body==='string'?body:JSON.stringify(body);res.writeHead(status,{'content-type':typeof body==='string'?'text/plain; charset=utf-8':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'same-origin',...headers});res.end(data); }
function cookies(req){return Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),decodeURIComponent(x.slice(i+1))];}));}
function sessionFor(req){const token=cookies(req).campusiq_session, s=token&&sessions.get(token);if(!s)return null;if(s.expires<Date.now()){sessions.delete(token);return null;}s.expires=Date.now()+SESSION_MS;return {token,...s};}
function audit(user,action,detail=''){statements.audit.run(new Date().toISOString(),user?.id??null,action,detail.slice(0,500));}
async function body(req){let chunks=[],size=0;for await(const chunk of req){size+=chunk.length;if(size>MAX_BODY)throw Object.assign(new Error('Request body too large'),{status:413});chunks.push(chunk);}const raw=Buffer.concat(chunks).toString('utf8');return req.headers['content-type']?.includes('application/json')?(raw?JSON.parse(raw):{}):raw;}
function safeOrigin(req){const origin=req.headers.origin;if(!origin)return true;try{return new URL(origin).host===req.headers.host;}catch{return false;}}
function userStudents(user){const rows=(user.role==='admin'?statements.allStudents.all():user.role==='student'?statements.ownStudents.all(user.studentId):statements.facultyStudents.all(user.id,user.id)).map(x=>JSON.parse(x.row_json));return rows.map(r=>({...r,id:r.student_id}));}
function userCases(user){if(user.role==='student')return {};const rows=user.role==='admin'?statements.allCases.all():db.prepare('SELECT c.student_id,c.case_json FROM cases c WHERE EXISTS (SELECT 1 FROM assignments a WHERE a.student_id=c.student_id AND a.user_id=?) OR EXISTS (SELECT 1 FROM course_enrollments e JOIN courses x ON x.id=e.course_id WHERE e.student_id=c.student_id AND x.faculty_id=?)').all(user.id,user.id);return Object.fromEntries(rows.map(x=>[x.student_id,JSON.parse(x.case_json)]));}
function userCourses(user){if(user.role==='admin')return db.prepare('SELECT c.*,u.display_name AS faculty_name FROM courses c JOIN users u ON u.id=c.faculty_id WHERE c.enabled=1 ORDER BY c.weekday,c.start_time').all();if(user.role==='faculty')return db.prepare('SELECT c.*,u.display_name AS faculty_name FROM courses c JOIN users u ON u.id=c.faculty_id WHERE c.enabled=1 AND c.faculty_id=? ORDER BY c.weekday,c.start_time').all(user.id);return db.prepare('SELECT c.*,u.display_name AS faculty_name FROM courses c JOIN users u ON u.id=c.faculty_id JOIN course_enrollments e ON e.course_id=c.id WHERE c.enabled=1 AND e.student_id=? ORDER BY c.weekday,c.start_time').all(user.studentId);}
function timetableConflict(studentId,weekday,start,end,skipCourseId=-1){return db.prepare('SELECT c.code FROM course_enrollments e JOIN courses c ON c.id=e.course_id WHERE e.student_id=? AND c.weekday=? AND c.enabled=1 AND c.id<>? AND c.start_time<? AND c.end_time>? LIMIT 1').get(studentId,weekday,skipCourseId,end,start);}
function campusSnapshot(user){
  const courses=userCourses(user),ids=courses.map(c=>c.id),marks=ids.map(()=>'?').join(',');
  const assignments=ids.length?db.prepare(`SELECT * FROM course_assignments WHERE course_id IN (${marks}) ORDER BY due_at`).all(...ids):[];
  const sessions=ids.length?db.prepare(`SELECT * FROM class_sessions WHERE course_id IN (${marks}) ORDER BY class_date DESC`).all(...ids):[];
  const enrollments=user.role!=='student'&&ids.length?db.prepare(`SELECT e.course_id,e.student_id,COALESCE(json_extract(s.row_json,'$.name'),e.student_id) AS name FROM course_enrollments e LEFT JOIN (SELECT student_id,row_json,MAX(term) term FROM students GROUP BY student_id) s ON s.student_id=e.student_id WHERE e.course_id IN (${marks}) ORDER BY name`).all(...ids):[];
  const sessionIds=sessions.map(x=>x.id),attendance=sessionIds.length?db.prepare(`SELECT a.*,s.course_id,s.class_date FROM attendance_records a JOIN class_sessions s ON s.id=a.session_id WHERE s.id IN (${sessionIds.map(()=>'?').join(',')}) ${user.role==='student'?'AND a.student_id=?':''} ORDER BY s.class_date DESC`).all(...(user.role==='student'?[...sessionIds,user.studentId]:sessionIds)):[];
  const submissions=assignments.length?db.prepare(`SELECT s.*,a.course_id,a.title AS assignment_title,a.due_at,a.max_points FROM submissions s JOIN course_assignments a ON a.id=s.assignment_id WHERE a.id IN (${assignments.map(()=>'?').join(',')}) ${user.role==='student'?'AND s.student_id=?':''}`).all(...(user.role==='student'?[...assignments.map(a=>a.id),user.studentId]:assignments.map(a=>a.id))):[];
  const scopedCourseRows=(table)=>{if(user.role==='student'){const ownRequest=table==='attendance_requests'?' AND x.student_id=?':'';return db.prepare(`SELECT x.*,c.code,c.title AS course_title FROM ${table} x JOIN courses c ON c.id=x.course_id JOIN course_enrollments e ON e.course_id=c.id WHERE e.student_id=?${ownRequest} ORDER BY x.created_at DESC LIMIT 100`).all(...(ownRequest?[user.studentId,user.studentId]:[user.studentId]));}return ids.length?db.prepare(`SELECT x.*,c.code,c.title AS course_title FROM ${table} x JOIN courses c ON c.id=x.course_id WHERE x.course_id IN (${marks}) ORDER BY x.created_at DESC LIMIT 100`).all(...ids):[];};
  const attendanceRequests=scopedCourseRows('attendance_requests');
  const announcements=scopedCourseRows('class_updates');
  const supportRequests=user.role==='student'?db.prepare('SELECT * FROM support_requests WHERE student_id=? ORDER BY created_at DESC LIMIT 100').all(user.studentId):user.role==='admin'?db.prepare('SELECT * FROM support_requests ORDER BY created_at DESC LIMIT 200').all():db.prepare('SELECT r.* FROM support_requests r WHERE EXISTS (SELECT 1 FROM assignments a WHERE a.student_id=r.student_id AND a.user_id=?) OR EXISTS (SELECT 1 FROM course_enrollments e JOIN courses c ON c.id=e.course_id WHERE e.student_id=r.student_id AND c.faculty_id=?) ORDER BY r.created_at DESC LIMIT 100').all(user.id,user.id);
  return {courses,assignments,sessions,attendance,enrollments,submissions,attendanceRequests,announcements,supportRequests};
}
function requireAuth(req,res){const s=sessionFor(req);if(!s){send(res,401,{error:'Sign in required'});return null;}const linked=statements.studentAccount.get(s.id);if(linked){s.role='student';s.studentId=linked.student_id;}return s;}
function route(req,res){
  const url=new URL(req.url,'http://localhost'); const p=url.pathname;
  if(p.startsWith('/api/')){
    if(['POST','PUT','PATCH','DELETE'].includes(req.method)&&!safeOrigin(req))return send(res,403,{error:'Origin check failed'});
    if(req.method==='POST'&&p==='/api/demo-role')return body(req).then(input=>{
      const role=String(input.role||'');if(!['admin','faculty','student'].includes(role))return send(res,400,{error:'Choose administrator, faculty, or student demo view.'});
      let user,student=null;
      if(role==='admin')user=db.prepare("SELECT * FROM users WHERE role='admin' AND enabled=1 ORDER BY CASE WHEN username='MUKUL_Admin' THEN 0 ELSE 1 END,id LIMIT 1").get();
      else if(role==='faculty')user=db.prepare("SELECT u.* FROM users u WHERE u.role='faculty' AND u.enabled=1 AND NOT EXISTS(SELECT 1 FROM student_accounts s WHERE s.user_id=u.id) ORDER BY CASE WHEN u.username='FAC-0001' THEN 0 ELSE 1 END,u.id LIMIT 1").get();
      else {const linked=db.prepare("SELECT u.*,s.student_id FROM users u JOIN student_accounts s ON s.user_id=u.id WHERE s.student_id='STU-0001' AND u.enabled=1 LIMIT 1").get();if(linked){user=linked;student={student_id:linked.student_id};}}
      if(!user)return send(res,503,{error:'That demo role is not available in the current synthetic dataset.'});
      const effectiveRole=student?'student':role,token=randomBytes(32).toString('base64url');sessions.set(token,{id:user.id,username:user.username,name:user.display_name,role:effectiveRole,studentId:student?.student_id,expires:Date.now()+SESSION_MS});audit(user,'demo_role_switch',effectiveRole);
      const secureCookie=req.socket.encrypted||process.env.COOKIE_SECURE==='true';return send(res,200,{user:{username:user.username,name:user.display_name,role:effectiveRole,studentId:student?.student_id},demo:true},{'set-cookie':`campusiq_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS/1000}${secureCookie?'; Secure':''}`});
    }).catch(e=>send(res,e.status||400,{error:e.message}));
    if(req.method==='GET'&&p==='/api/session'){const s=sessionFor(req);if(!s)return send(res,401,{error:'Sign in required'});const linked=statements.studentAccount.get(s.id);return send(res,200,{user:{username:s.username,name:s.name,role:linked?'student':s.role,studentId:linked?.student_id}});}
    if(req.method==='POST'&&p==='/api/login')return body(req).then(input=>{
      const key=req.socket.remoteAddress||'local', recent=(attempts.get(key)||[]).filter(t=>Date.now()-t<15*60*1000);if(recent.length>=10)return send(res,429,{error:'Too many attempts. Try again in 15 minutes.'});
      const user=statements.userByName.get(String(input.username||'').trim());let ok=false;
      if(user){const derived=scryptSync(String(input.password||''),user.salt,64);ok=timingSafeEqual(derived,user.password_hash);}
      if(!ok){recent.push(Date.now());attempts.set(key,recent);return send(res,401,{error:'Username or password is incorrect'});}
      attempts.delete(key);const student=statements.studentAccount.get(user.id),role=student?'student':user.role,token=randomBytes(32).toString('base64url');sessions.set(token,{id:user.id,username:user.username,name:user.display_name,role,studentId:student?.student_id,expires:Date.now()+SESSION_MS});audit(user,'login',role);
      const secureCookie=req.socket.encrypted||process.env.COOKIE_SECURE==='true';
      return send(res,200,{user:{username:user.username,name:user.display_name,role,studentId:student?.student_id}},{'set-cookie':`campusiq_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS/1000}${secureCookie?'; Secure':''}`});
    }).catch(e=>send(res,e.status||400,{error:e.message}));
    if(req.method==='POST'&&p==='/api/logout'){const s=sessionFor(req);if(s){audit(s,'logout');sessions.delete(s.token);}return send(res,200,{ok:true},{'set-cookie':'campusiq_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});}
    const user=requireAuth(req,res);if(!user)return;
    if(req.method==='GET'&&p==='/api/students'){audit(user,'student_list',user.role);return send(res,200,{students:userStudents(user),role:user.role});}
    if(req.method==='GET'&&p==='/api/cases')return send(res,200,{cases:userCases(user)});
    if(req.method==='GET'&&p==='/api/campus'){audit(user,'campus_view',user.role);return send(res,200,campusSnapshot(user));}
    if(req.method==='GET'&&p==='/api/users'){
      if(user.role!=='admin')return send(res,403,{error:'Only administrators can manage accounts'});
      const users=db.prepare('SELECT u.id,u.username,u.display_name,u.role,u.enabled,sa.student_id FROM users u LEFT JOIN student_accounts sa ON sa.user_id=u.id ORDER BY u.role,u.username').all().map(x=>({...x,role:x.student_id?'student':x.role}));return send(res,200,{users});
    }
    if(req.method==='GET'&&p==='/api/audit'){
      if(user.role!=='admin')return send(res,403,{error:'Only administrators can view the access log'});return send(res,200,{events:db.prepare('SELECT a.at,COALESCE(u.username,?) AS username,a.action,a.detail FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 200').all('system')});
    }
    if(req.method==='POST'&&p==='/api/users')return body(req).then(input=>{
      if(user.role!=='admin')return send(res,403,{error:'Only administrators can create accounts'});
      const username=String(input.username||'').trim(),name=String(input.display_name||'').trim(),role=String(input.role||''),password=String(input.password||''),studentId=String(input.student_id||'').trim();
      if(!/^[a-zA-Z0-9._-]{3,60}$/.test(username)||!name||!['admin','faculty','student'].includes(role)||password.length<12)return send(res,400,{error:'Use a 3–60 character username, display name, role, and password with at least 12 characters.'});
      if(role==='student'&&!statements.ownStudents.get(studentId))return send(res,400,{error:'Student ID was not found in the current cohort.'});
      const salt=randomBytes(16),hash=scryptSync(password,salt,64);try{db.exec('BEGIN');const created=statements.createUser.run(username,name,role==='student'?'faculty':role,salt,hash);if(role==='student')db.prepare('INSERT INTO student_accounts(user_id,student_id) VALUES(?,?)').run(Number(created.lastInsertRowid),studentId);db.exec('COMMIT');audit(user,'account_create',`${role}:${username}`);return send(res,201,{ok:true});}catch(e){db.exec('ROLLBACK');return send(res,409,{error:e.code?.includes('CONSTRAINT')?'Username is already in use.':'Could not create account.'});}
    }).catch(e=>send(res,e.status||400,{error:e.message}));
    if(req.method==='PATCH'&&/^\/api\/users\/\d+$/.test(p))return body(req).then(input=>{
      if(user.role!=='admin')return send(res,403,{error:'Only administrators can change account access'});const id=Number(p.split('/').at(-1));if(id===user.id&&input.enabled===false)return send(res,400,{error:'You cannot disable your own active account.'});if(typeof input.enabled!=='boolean')return send(res,400,{error:'enabled must be true or false'});const result=db.prepare('UPDATE users SET enabled=? WHERE id=?').run(input.enabled?1:0,id);if(!result.changes)return send(res,404,{error:'Account not found'});audit(user,'account_access',`${id}:${input.enabled?'enabled':'disabled'}`);return send(res,200,{ok:true});
    }).catch(e=>send(res,e.status||400,{error:e.message}));
    if(req.method==='POST'&&p==='/api/courses')return body(req).then(input=>{
      if(!['admin','faculty'].includes(user.role))return send(res,403,{error:'Only faculty or administrators can create a class'});
      const code=String(input.code||'').trim().toUpperCase(),title=String(input.title||'').trim(),room=String(input.room||'').trim(),weekday=Number(input.weekday),start=String(input.start_time||''),end=String(input.end_time||'');
      if(!code||!title||!Number.isInteger(weekday)||weekday<0||weekday>6||!/^([01]\d|2[0-3]):[0-5]\d$/.test(start)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(end)||start>=end)return send(res,400,{error:'Enter a course code, title, weekday, room, and valid start/end times.'});
      let facultyId=user.id;if(user.role==='admin'){const target=statements.findUserId.get(String(input.faculty_username||''));if(!target)return send(res,400,{error:'Choose an active faculty account.'});facultyId=target.id;}
      const overlap=db.prepare("SELECT code FROM courses WHERE enabled=1 AND faculty_id=? AND weekday=? AND start_time<? AND end_time>? LIMIT 1").get(facultyId,weekday,end,start);if(overlap)return send(res,409,{error:`This faculty member already has ${overlap.code} during that time.`});
      const studentIds=[...new Set((Array.isArray(input.student_ids)?input.student_ids:[]).map(x=>String(x).trim()).filter(Boolean))];if(studentIds.length&&user.role!=='admin')return send(res,403,{error:'Only administrators can enroll students in a class.'});for(const sid of studentIds){if(!db.prepare('SELECT 1 FROM students WHERE student_id=? LIMIT 1').get(sid))return send(res,400,{error:`Student ID ${sid} was not found.`});const conflict=timetableConflict(sid,weekday,start,end);if(conflict)return send(res,409,{error:`${sid} has a timetable conflict with ${conflict.code}.`});}
      try{db.exec('BEGIN');const result=db.prepare('INSERT INTO courses(code,title,weekday,start_time,end_time,room,faculty_id) VALUES(?,?,?,?,?,?,?)').run(code,title,weekday,start,end,room,facultyId);const enroll=db.prepare('INSERT OR IGNORE INTO course_enrollments(course_id,student_id) VALUES(?,?)');for(const sid of studentIds)enroll.run(Number(result.lastInsertRowid),sid);db.exec('COMMIT');audit(user,'course_create',code);return send(res,201,{ok:true});}catch(e){db.exec('ROLLBACK');return send(res,409,{error:e.code?.includes('CONSTRAINT')?'Course code is already in use.':'Could not create class.'});}
    }).catch(e=>send(res,e.status||400,{error:e.message}));
    if(req.method==='POST'&&p==='/api/enroll')return body(req).then(input=>{
      if(user.role!=='admin')return send(res,403,{error:'Only administrators can manage course rosters.'});const courseId=Number(input.course_id),course=db.prepare('SELECT * FROM courses WHERE id=?').get(courseId);if(!course)return send(res,404,{error:'Class not found.'});const ids=[...new Set((Array.isArray(input.student_ids)?input.student_ids:[]).map(x=>String(x).trim()).filter(Boolean))];for(const sid of ids){if(!db.prepare('SELECT 1 FROM students WHERE student_id=? LIMIT 1').get(sid))return send(res,400,{error:`Student ID ${sid} was not found in the current cohort.`});const conflict=timetableConflict(sid,course.weekday,course.start_time,course.end_time,courseId);if(conflict)return send(res,409,{error:`${sid} has a timetable conflict with ${conflict.code}.`});}db.exec('BEGIN');try{if(input.replace===true)db.prepare('DELETE FROM course_enrollments WHERE course_id=?').run(courseId);const add=db.prepare('INSERT OR IGNORE INTO course_enrollments(course_id,student_id) VALUES(?,?)');for(const sid of ids)add.run(courseId,sid);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}audit(user,'roster_update',String(courseId));return send(res,200,{ok:true});
    }).catch(e=>send(res,e.status||400,{error:e.message}));
    if(req.method==='POST'&&p==='/api/attendance')return body(req).then(input=>{
      if(!['admin','faculty'].includes(user.role))return send(res,403,{error:'Students cannot mark class attendance.'});const courseId=Number(input.course_id),classDate=String(input.class_date||''),course=userCourses(user).find(c=>c.id===courseId);if(!course)return send(res,404,{error:'Class not found in your authorized courses.'});if(!/^\d{4}-\d{2}-\d{2}$/.test(classDate)||!Number.isFinite(Date.parse(classDate)))return send(res,400,{error:'Choose a valid class date.'});const roster=db.prepare('SELECT student_id FROM course_enrollments WHERE course_id=?').all(courseId).map(x=>x.student_id),marks=input.attendance;if(!marks||typeof marks!=='object')return send(res,400,{error:'Attendance entries are required.'});const allowed=new Set(['Present','Absent','Late']);for(const sid of roster)if(!allowed.has(marks[sid]))return send(res,400,{error:`Mark ${sid} present, absent, or late before saving.`});
      const now=new Date().toISOString();db.exec('BEGIN');try{db.prepare('INSERT INTO class_sessions(course_id,class_date,created_at,created_by) VALUES(?,?,?,?) ON CONFLICT(course_id,class_date) DO UPDATE SET created_at=excluded.created_at,created_by=excluded.created_by').run(courseId,classDate,now,user.id);const session=db.prepare('SELECT id FROM class_sessions WHERE course_id=? AND class_date=?').get(courseId,classDate);const put=db.prepare("INSERT INTO attendance_records(session_id,student_id,status,updated_at) VALUES(?,?,?,?) ON CONFLICT(session_id,student_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at");for(const sid of roster)put.run(session.id,sid,marks[sid],now);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}audit(user,'attendance_save',`${course.code}:${classDate}`);return send(res,200,{ok:true});
    }).catch(e=>send(res,e.status||400,{error:e.message}));
    if(req.method==='POST'&&p==='/api/attendance-requests')return body(req).then(input=>{
      if(user.role!=='student')return send(res,403,{error:'Attendance correction requests are for student accounts.'});
      const courseId=Number(input.course_id),classDate=String(input.class_date||''),desired=String(input.desired_status||''),reason=String(input.reason||'').trim(),course=userCourses(user).find(c=>c.id===courseId);
      if(!course)return send(res,404,{error:'Choose one of your enrolled classes.'});
      if(!/^\d{4}-\d{2}-\d{2}$/.test(classDate)||Date.parse(classDate)>Date.now())return send(res,400,{error:'Choose a past class date.'});
      if(!['Present','Absent','Late'].includes(desired)||reason.length<8||reason.length>1200)return send(res,400,{error:'Choose the correct status and explain the request in at least 8 characters.'});
      const session=db.prepare('SELECT id FROM class_sessions WHERE course_id=? AND class_date=?').get(courseId,classDate);
      if(!session)return send(res,404,{error:'Your faculty has not recorded attendance for that class date yet.'});
      const mark=db.prepare('SELECT status FROM attendance_records WHERE session_id=? AND student_id=?').get(session.id,user.studentId);
      if(!mark)return send(res,404,{error:'No attendance record was found for you on that date.'});
      if(mark.status===desired)return send(res,400,{error:'That is already the recorded attendance status.'});
      if(db.prepare("SELECT 1 FROM attendance_requests WHERE student_id=? AND course_id=? AND class_date=? AND status='Pending'").get(user.studentId,courseId,classDate))return send(res,409,{error:'You already have a pending request for this class date.'});
      db.prepare('INSERT INTO attendance_requests(course_id,student_id,class_date,desired_status,reason,created_at) VALUES(?,?,?,?,?,?)').run(courseId,user.studentId,classDate,desired,reason,new Date().toISOString());audit(user,'attendance_correction_request',`${course.code}:${classDate}`);return send(res,201,{ok:true});
    }).catch(e=>send(res,e.status||400,{error:e.message}));
    if(req.method==='PATCH'&&/^\/api\/attendance-requests\/\d+$/.test(p))return body(req).then(input=>{
      if(!['admin','faculty'].includes(user.role))return send(res,403,{error:'Only faculty or administrators can review attendance requests.'});
      const id=Number(p.split('/').at(-1)),request=db.prepare('SELECT r.*,c.code FROM attendance_requests r JOIN courses c ON c.id=r.course_id WHERE r.id=?').get(id);
      if(!request)return send(res,404,{error:'Attendance request not found.'});
      if(user.role==='faculty'&&!userCourses(user).some(c=>c.id===request.course_id))return send(res,403,{error:'This request is outside your classes.'});
      if(request.status!=='Pending')return send(res,409,{error:'This request has already been reviewed.'});
      const decision=String(input.decision||''),response=String(input.response||'').trim().slice(0,1200);
      if(!['Approved','Declined'].includes(decision))return send(res,400,{error:'Choose Approve or Decline.'});
      const session=db.prepare('SELECT id FROM class_sessions WHERE course_id=? AND class_date=?').get(request.course_id,request.class_date);
      if(decision==='Approved'&&!session)return send(res,409,{error:'The class attendance session no longer exists.'});
      db.exec('BEGIN');try{if(decision==='Approved')db.prepare('UPDATE attendance_records SET status=?,updated_at=? WHERE session_id=? AND student_id=?').run(request.desired_status,new Date().toISOString(),session.id,request.student_id);db.prepare('UPDATE attendance_requests SET status=?,reviewed_by=?,reviewed_at=?,response=? WHERE id=?').run(decision,user.id,new Date().toISOString(),response,id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
      audit(user,'attendance_correction_review',`${request.code}:${request.class_date}:${decision}`);return send(res,200,{ok:true});
    }).catch(e=>send(res,e.status||400,{error:e.message}));
    if(req.method==='POST'&&p==='/api/support-requests')return body(req).then(input=>{
      if(user.role!=='student')return send(res,403,{error:'Only students can open a personal support request.'});
      const category=String(input.category||'Other'),message=String(input.message||'').trim();
      if(!['Academic','Attendance','Wellbeing','Financial','Technical','Other'].includes(category)||message.length<8||message.length>2000)return send(res,400,{error:'Choose a category and enter a message of 8–2000 characters.'});
      db.prepare('INSERT INTO support_requests(student_id,category,message,created_at) VALUES(?,?,?,?)').run(user.studentId,category,message,new Date().toISOString());audit(user,'support_request_open',category);return send(res,201,{ok:true});
    }).catch(e=>send(res,e.status||400,{error:e.message}));
    if(req.method==='PATCH'&&/^\/api\/support-requests\/\d+$/.test(p))return body(req).then(input=>{
      if(!['admin','faculty'].includes(user.role))return send(res,403,{error:'Only faculty or administrators can update support requests.'});
      const id=Number(p.split('/').at(-1)),request=db.prepare('SELECT * FROM support_requests WHERE id=?').get(id);if(!request)return send(res,404,{error:'Support request not found.'});
      if(user.role==='faculty'&&!db.prepare('SELECT 1 WHERE EXISTS (SELECT 1 FROM assignments WHERE student_id=? AND user_id=?) OR EXISTS (SELECT 1 FROM course_enrollments e JOIN courses c ON c.id=e.course_id WHERE e.student_id=? AND c.faculty_id=?)').get(request.student_id,user.id,request.student_id,user.id))return send(res,403,{error:'This student is outside your authorized classes.'});
      const status=String(input.status||''),response=String(input.response||'').trim().slice(0,1200);if(!['Open','In progress','Resolved'].includes(status))return send(res,400,{error:'Choose Open, In progress, or Resolved.'});
      db.prepare('UPDATE support_requests SET status=?,reviewed_by=?,reviewed_at=?,response=? WHERE id=?').run(status,user.id,new Date().toISOString(),response,id);audit(user,'support_request_update',`${request.student_id}:${status}`);return send(res,200,{ok:true});
    }).catch(e=>send(res,e.status||400,{error:e.message}));
    if(req.method==='POST'&&p==='/api/announcements')return body(req).then(input=>{
      if(!['admin','faculty'].includes(user.role))return send(res,403,{error:'Only faculty or administrators can post class updates.'});
      const courseId=Number(input.course_id),course=userCourses(user).find(c=>c.id===courseId),kind=String(input.kind||'announcement'),category=String(input.category||'General'),title=String(input.title||'').trim(),message=String(input.message||'').trim(),applies=String(input.applies_on||'').trim();
      if(!course)return send(res,404,{error:'Choose a class you are authorized to update.'});
      if(!['announcement','cancellation'].includes(kind)||!['General','Exam','Assignment','Deadline','Room change','Timetable','Study material','Event','Holiday','Emergency'].includes(category)||!title||!message||title.length>160||message.length>3000)return send(res,400,{error:'Choose a valid category and enter a title and message.'});
      if(kind==='cancellation'&&(!/^\d{4}-\d{2}-\d{2}$/.test(applies)||!Number.isFinite(Date.parse(applies))))return send(res,400,{error:'Choose the cancellation date.'});
      db.prepare('INSERT INTO class_updates(course_id,created_by,kind,category,title,message,applies_on,created_at) VALUES(?,?,?,?,?,?,?,?)').run(courseId,user.id,kind,category,title,message,applies||null,new Date().toISOString());audit(user,kind,`${course.code}:${category}:${title}`);return send(res,201,{ok:true});
    }).catch(e=>send(res,e.status||400,{error:e.message}));
    if(req.method==='PATCH'&&/^\/api\/courses\/\d+$/.test(p))return body(req).then(input=>{
      if(!['admin','faculty'].includes(user.role))return send(res,403,{error:'Only faculty or administrators can change a timetable.'});
      const id=Number(p.split('/').at(-1)),course=userCourses(user).find(c=>c.id===id);if(!course)return send(res,404,{error:'Class not found in your authorized courses.'});
      const weekday=Number(input.weekday),start=String(input.start_time||''),end=String(input.end_time||''),room=String(input.room||'').trim();
      if(!Number.isInteger(weekday)||weekday<1||weekday>5||!/^([01]\d|2[0-3]):[0-5]\d$/.test(start)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(end)||start>=end)return send(res,400,{error:'Choose a weekday, room, and valid class times.'});
      const facultyOverlap=db.prepare('SELECT code FROM courses WHERE enabled=1 AND faculty_id=? AND weekday=? AND id<>? AND start_time<? AND end_time>? LIMIT 1').get(course.faculty_id,weekday,id,end,start);if(facultyOverlap)return send(res,409,{error:`Faculty already has ${facultyOverlap.code} at that time.`});
      const roster=db.prepare('SELECT student_id FROM course_enrollments WHERE course_id=?').all(id);for(const row of roster){const conflict=timetableConflict(row.student_id,weekday,start,end,id);if(conflict)return send(res,409,{error:`${row.student_id} has a timetable conflict with ${conflict.code}.`});}
      const dayNames=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'],oldText=`${dayNames[course.weekday]} ${course.start_time}–${course.end_time}, ${course.room||'room not set'}`,newText=`${dayNames[weekday]} ${start}–${end}, ${room||'room not set'}`;
      db.exec('BEGIN');try{db.prepare('UPDATE courses SET weekday=?,start_time=?,end_time=?,room=? WHERE id=?').run(weekday,start,end,room,id);if(oldText!==newText)db.prepare('INSERT INTO class_updates(course_id,created_by,kind,title,message,created_at) VALUES(?,?,?,?,?,?)').run(id,user.id,'timetable_change',`Timetable changed: ${course.code}`,`${oldText} → ${newText}`,new Date().toISOString());db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
      audit(user,'timetable_change',`${course.code}:${oldText} -> ${newText}`);return send(res,200,{ok:true});
    }).catch(e=>send(res,e.status||400,{error:e.message}));
    if(req.method==='POST'&&p==='/api/assignments')return body(req).then(input=>{
      if(!['admin','faculty'].includes(user.role))return send(res,403,{error:'Only faculty or administrators can publish assignments.'});const courseId=Number(input.course_id),course=userCourses(user).find(c=>c.id===courseId);if(!course)return send(res,404,{error:'Class not found in your authorized courses.'});const title=String(input.title||'').trim(),instructions=String(input.instructions||'').trim(),dueAt=String(input.due_at||''),max=Number(input.max_points||100),allowLate=input.allow_late===true?1:0;if(!title||!instructions||!Number.isFinite(Date.parse(dueAt))||!Number.isFinite(max)||max<=0||max>1000)return send(res,400,{error:'Enter a title, instructions, valid due date, and maximum score (1–1000).'});db.prepare('INSERT INTO course_assignments(course_id,title,instructions,due_at,max_points,allow_late,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)').run(courseId,title,instructions,dueAt,max,allowLate,user.id,new Date().toISOString());audit(user,'assignment_publish',`${course.code}:${title}`);return send(res,201,{ok:true});
    }).catch(e=>send(res,e.status||400,{error:e.message}));
    if(req.method==='POST'&&p==='/api/submissions')return body(req).then(input=>{
      if(user.role!=='student')return send(res,403,{error:'Only student accounts can submit work.'});const assignmentId=Number(input.assignment_id),answer=String(input.answer_text||'').trim(),fileData=String(input.file_data||''),fileName=String(input.file_name||'').split(/[\\/]/).pop().slice(0,180),fileType=String(input.file_type||'application/octet-stream').slice(0,120),assignment=db.prepare('SELECT a.*,c.code FROM course_assignments a JOIN courses c ON c.id=a.course_id JOIN course_enrollments e ON e.course_id=c.id WHERE a.id=? AND e.student_id=?').get(assignmentId,user.studentId);if(!assignment)return send(res,404,{error:'Assignment not found for your enrolled classes.'});if(Date.parse(assignment.due_at)<Date.now()&&!assignment.allow_late)return send(res,400,{error:'The deadline has passed; contact your faculty about a late submission.'});if(!answer&&!fileData)return send(res,400,{error:'Write a response or attach a file before submitting.'});if(fileData.length>7_000_000||!/^[A-Za-z0-9+/]*={0,2}$/.test(fileData))return send(res,400,{error:'Attachment must be a valid file no larger than 5 MB.'});db.prepare("INSERT INTO submissions(assignment_id,student_id,answer_text,file_name,file_type,file_data,submitted_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(assignment_id,student_id) DO UPDATE SET answer_text=excluded.answer_text,file_name=excluded.file_name,file_type=excluded.file_type,file_data=excluded.file_data,submitted_at=excluded.submitted_at,score=NULL,feedback='',graded_at=NULL").run(assignmentId,user.studentId,answer.slice(0,50000),fileName,fileType,fileData,new Date().toISOString());audit(user,'assignment_submit',String(assignmentId));return send(res,200,{ok:true});
    }).catch(e=>send(res,e.status||400,{error:e.message}));
    if(req.method==='PATCH'&&/^\/api\/submissions\/\d+$/.test(p))return body(req).then(input=>{
      if(!['admin','faculty'].includes(user.role))return send(res,403,{error:'Students cannot grade submissions.'});const id=Number(p.split('/').at(-1)),row=db.prepare('SELECT s.*,a.max_points,a.course_id FROM submissions s JOIN course_assignments a ON a.id=s.assignment_id WHERE s.id=?').get(id);if(!row)return send(res,404,{error:'Submission not found'});if(user.role==='faculty'&&!userCourses(user).some(c=>c.id===row.course_id))return send(res,403,{error:'This submission is outside your assigned classes.'});const score=Number(input.score),feedback=String(input.feedback||'').slice(0,4000);if(!Number.isFinite(score)||score<0||score>row.max_points)return send(res,400,{error:`Score must be between 0 and ${row.max_points}.`});db.prepare('UPDATE submissions SET score=?,feedback=?,graded_at=? WHERE id=?').run(score,feedback,new Date().toISOString(),id);audit(user,'submission_grade',String(id));return send(res,200,{ok:true});
    }).catch(e=>send(res,e.status||400,{error:e.message}));
    if(req.method==='POST'&&p==='/api/import'){
      if(user.role!=='admin')return send(res,403,{error:'Only administrators can import cohort data'});
      return body(req).then(input=>{const {good,issues}=normalizeCsv(String(input.csv||''));if(!good.length)return send(res,400,{error:'No valid records found',issues:issues.slice(0,20)});
        const tx=db.prepare('INSERT INTO students(student_id,term,row_json) VALUES(?,?,?) ON CONFLICT(student_id,term) DO UPDATE SET row_json=excluded.row_json');db.exec('BEGIN');try{db.exec('DELETE FROM students');for(const r of good)tx.run(r.student_id,r.term,JSON.stringify(r));db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
        audit(user,'cohort_import',`${good.length} rows`);return send(res,200,{students:userStudents(user),accepted:good.length,issues:issues.slice(0,30)});
      }).catch(e=>send(res,e.status||400,{error:e.message}));
    }
    if(req.method==='POST'&&p==='/api/cases')return body(req).then(input=>{
      if(user.role==='student')return send(res,403,{error:'Student accounts cannot edit staff follow-up cases'});
      const requested=input.cases;if(!requested||typeof requested!=='object')return send(res,400,{error:'cases object required'});
      const allowed=new Set(userStudents(user).map(r=>r.student_id));if(user.role==='admin')for(const r of statements.allStudents.all())allowed.add(JSON.parse(r.row_json).student_id);
      const tx=db.prepare('INSERT INTO cases(student_id,case_json,updated_at) VALUES(?,?,?) ON CONFLICT(student_id) DO UPDATE SET case_json=excluded.case_json,updated_at=excluded.updated_at');let saved=0;const validStatuses=new Set(['Open','In progress','Completed']);
      db.exec('BEGIN');try{for(const [id,c] of Object.entries(requested)){if(!allowed.has(id)||!c||typeof c!=='object')continue;const clean={owner:user.role==='faculty'?user.name:String(c.owner||'').slice(0,120),due:/^\d{4}-\d{2}-\d{2}$/.test(c.due||'')?c.due:'',plan:String(c.plan||'').slice(0,4000),status:validStatuses.has(c.status)?c.status:'Open',baselineScore:Number.isFinite(Number(c.baselineScore))?Number(c.baselineScore):null,log:Array.isArray(c.log)?c.log.slice(-100).map(x=>({date:String(x.date||'').slice(0,40),note:String(x.note||'').slice(0,2000),score:Number.isFinite(Number(x.score))?Number(x.score):null})):[]};tx.run(id,JSON.stringify(clean),new Date().toISOString());saved++;}db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
      audit(user,'cases_save',`${saved} cases`);return send(res,200,{ok:true,cases:userCases(user)});
    }).catch(e=>send(res,e.status||400,{error:e.message}));
    if(req.method==='POST'&&p==='/api/assign')return body(req).then(input=>{
      if(user.role!=='admin')return send(res,403,{error:'Only administrators can assign students'});
      const target=statements.findUserId.get(String(input.username||'')),student=String(input.student_id||'');if(!target)return send(res,404,{error:'Faculty account not found'});
      if(!db.prepare('SELECT 1 FROM students WHERE student_id=? LIMIT 1').get(student))return send(res,404,{error:'Student not found'});
      statements.assign.run(student,target.id);audit(user,'student_assign',`${student} → ${input.username}`);return send(res,200,{ok:true});
    }).catch(e=>send(res,e.status||400,{error:e.message}));
    return send(res,404,{error:'API route not found'});
  }
  if(req.method!=='GET'&&req.method!=='HEAD')return send(res,405,'Method not allowed');
  let relative=decodeURIComponent(p==='/'?'/index.html':p);let file=path.resolve(root,'.'+relative);if(!file.startsWith(root+path.sep))return send(res,403,'Forbidden');if(!publicFiles.has(path.relative(root,file).replaceAll('\\','/')))return send(res,404,'Not found');
  if(!fs.existsSync(file)||!fs.statSync(file).isFile())return send(res,404,'Not found');
  res.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream','cache-control':path.extname(file)==='.html'?'no-store':'public, max-age=300','x-content-type-options':'nosniff','referrer-policy':'same-origin'});if(req.method==='HEAD')return res.end();fs.createReadStream(file).pipe(res);
}

function cli(){const [command,username,role,name]=process.argv.slice(2);if(command==='add-user'){
  if(!username||!['admin','faculty'].includes(role))throw new Error('Usage: CAMPUSIQ_USER_PASSWORD=<password> node server.js add-user <username> <admin|faculty> [display-name]');
  const password=process.env.CAMPUSIQ_USER_PASSWORD;if(!password||password.length<12)throw new Error('Set CAMPUSIQ_USER_PASSWORD to a password with at least 12 characters.');
  const salt=randomBytes(16),hash=scryptSync(password,salt,64);statements.createUser.run(username,name||username,role,salt,hash);console.log(`Created ${role} account: ${username}`);return true;
  }
  if(command==='add-student'){
    const [studentUsername,studentId,displayName]=process.argv.slice(3);if(!studentUsername||!studentId)throw new Error('Usage: CAMPUSIQ_USER_PASSWORD=<password> node server.js add-student <username> <student_id> [display-name]');
    const password=process.env.CAMPUSIQ_USER_PASSWORD;if(!password||password.length<12)throw new Error('Set CAMPUSIQ_USER_PASSWORD to a password with at least 12 characters.');
    if(!statements.ownStudents.get(studentId))throw new Error(`Student ID ${studentId} was not found in the current cohort.`);
    const salt=randomBytes(16),hash=scryptSync(password,salt,64);db.exec('BEGIN');try{const result=statements.createUser.run(studentUsername,displayName||studentUsername,'faculty',salt,hash);db.prepare('INSERT INTO student_accounts(user_id,student_id) VALUES(?,?)').run(Number(result.lastInsertRowid),studentId);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}console.log(`Created student account for ${studentId}: ${studentUsername}`);return true;
  }
  if(command==='assign'){
    const [studentId,facultyName]=process.argv.slice(3);const u=facultyName&&statements.findUserId.get(facultyName);if(!u)throw new Error('Usage: node server.js assign <student_id> <faculty-username>');if(!db.prepare('SELECT 1 FROM students WHERE student_id=? LIMIT 1').get(studentId))throw new Error('Student ID not found in the imported cohort.');statements.assign.run(studentId,u.id);console.log(`Assigned ${studentId} to ${facultyName}`);return true;
  }
  return false;
}
try{if(cli())process.exit(0);}catch(e){console.error(e.message);process.exit(1);}
const hasAssignedPort=Boolean(process.env.PORT);const firstPort=Number(process.env.PORT||4173);const host=process.env.HOST||(process.env.RAILWAY_ENVIRONMENT?'0.0.0.0':'127.0.0.1');
if(!Number.isInteger(firstPort)||firstPort<1||firstPort>65535)throw new Error('PORT must be a valid TCP port number.');
const server=http.createServer((req,res)=>{try{const result=route(req,res);if(result?.catch)result.catch(e=>{console.error('CampusIQ request error:',req.method,req.url,e);send(res,500,{error:'Internal server error'});});}catch(e){console.error('CampusIQ request error:',req.method,req.url,e);send(res,e.status||500,{error:e.status?e.message:'Internal server error'});}});
function listenAt(port){const onError=error=>{server.removeListener('listening',onListening);if(error.code==='EADDRINUSE'&&!hasAssignedPort&&port<firstPort+20){console.warn(`Port ${port} is busy; trying ${port+1}.`);listenAt(port+1);return;}throw error;};const onListening=()=>{server.removeListener('error',onError);console.log(`CampusIQ listening on ${host}:${port}`);};server.once('error',onError);server.once('listening',onListening);server.listen(port,host);}
listenAt(firstPort);
