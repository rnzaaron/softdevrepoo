// Backend: accepts browser requests, checks permissions, and reads/writes MongoDB.
// `require` loads installed tools and `dotenv` makes private .env settings available here.
require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
// `const` means these references are set once; `process.env` reads settings supplied at startup.
const PORT = Number(process.env.PORT || 3000);
const MONGO_URL = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
// Prefer an explicit database override, otherwise honor the database in the URI.
// Keep the historical default only when the local URI has no database path.
const DB_NAME = process.env.MONGODB_DB || decodeURIComponent(new URL(MONGO_URL).pathname.slice(1)) || 'st_catherine_academic';
const sessions = new Map();
let db;

// Middleware runs before routes: decode JSON forms, serve the Excel helper and public website.
app.use(express.json({ limit: '8mb' }));
app.use('/vendor', express.static(path.join(__dirname, 'node_modules', 'exceljs', 'dist')));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Small helpers keep route handlers consistent: collection selects a MongoDB table,
// route turns rejected async work into a logged server error, and auth checks the session.
const collection = name => db.collection(name);
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const sendError = (res, error, status = 400) => res.status(status).json({ error });
const route = handler => (req, res) => Promise.resolve(handler(req, res)).catch(error => {
  console.error(error);
  res.status(500).json({ error: 'The request could not be completed.' });
});
const auth = roles => (req, res, next) => {
  const user = sessions.get(req.get('token'));
  if (!user || (roles && !roles.includes(user.role))) return sendError(res, 'Please sign in with an authorized account.', 401);
  req.user = user;
  next();
};
const cleanUser = user => {
  const { pw, ...safe } = user;
  return safe;
};
const safeId = id => ObjectId.isValid(id) ? new ObjectId(id) : null;
const overlap = (a, b) => a.day === b.day && a.start < b.end && b.start < a.end;
const publicSchedule = row => ({ ...row, _id: String(row._id) });

// A simple connectivity check: save one sample document, then return its result as JSON.
app.get('/api/test', async (req, res) => {
  try {
    const document = { message: 'MongoDB is working!', school: 'St. Catherine College of Valenzuela City' };
    const result = await collection('tests').insertOne(document);

    res.json({
      success: true,
      message: 'Data saved to MongoDB!',
      data: { _id: result.insertedId, ...document }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ---------- Authentication and role-scoped data ----------
// A route maps a browser URL to work on the server. POST changes data; GET reads it.
// The auth(...) middleware limits who can proceed; async/await waits for MongoDB operations.
app.post('/api/login', route(async (req, res) => {
  const user = await collection('users').findOne({ email: String(req.body.email || '').toLowerCase(), pw: hash(req.body.password || '') });
  if (!user) return sendError(res, 'Email or password is incorrect.', 401);
  const token = crypto.randomUUID();
  sessions.set(token, cleanUser(user));
  res.json({ token, user: cleanUser(user) });
}));
app.get('/api/me', auth(), (req, res) => res.json(req.user));

app.get('/api/stats', auth(), route(async (req, res) => {
  const role = req.user.role;
  const section = req.user.section;
  const uploadsFilter = role === 'teacher' ? { teacherEmail: req.user.email }
    : ['adviser', 'student'].includes(role) ? { section } : role === 'parent' ? { _id: { $exists: false } } : {};
  const uploads = await collection('uploads').find(uploadsFilter).sort({ uploadedAt: -1 }).limit(20).toArray();
  const noteTargets = [{ to: req.user.email }, { role }, { target: 'all' }];
  if (section) noteTargets.push({ section });
  const noteFilter = { $or: noteTargets };
  const schedules = await getSchedules(req.user);
  const grades = await getGrades(req.user);
  const announcements = await visibleAnnouncements(req.user);
  const notes = await collection('notifications').find(noteFilter).sort({ at: -1 }).limit(8).toArray();
  res.json({ students: await collection('students').countDocuments(), teachers: await collection('teachers').countDocuments(),
    sections: await collection('sections').countDocuments(), uploads, grades: grades.slice(0, 8), schedules: schedules.slice(0, 8),
    announcements: announcements.slice(0, 4), notes,
    pendingProfessors: role === 'adviser' ? await (async () => {
      const assignments = await collection('teacher_assignments').find({ section }).toArray();
      const periods = ['Prelim', 'Midterm', 'Final'];
      return assignments.flatMap(assignment => periods.map(period => {
        const submission = uploads.find(item => item.subject === assignment.subject && item.teacherEmail === assignment.teacherEmail && item.period === period);
        return { ...assignment, period, status: submission?.status || 'Not submitted' };
      })).filter(item => !['Approved', 'Finalized'].includes(item.status));
    })() : uploads.filter(item => !['Approved', 'Finalized'].includes(item.status)) });
}));

// ---------- Grade upload, review, computation, and release ----------
// Teachers upload spreadsheet rows; the server validates scores and calculates weighted grades.
// Advisers move each upload through correction, approval, and final release.
app.post('/api/uploads', auth(['teacher']), route(async (req, res) => {
  const { subject, section, period, rows } = req.body;
  const config = await collection('config').findOne({ _id: 'system' });
  const weights = config?.weights || { Quiz: 0.3, Exam: 0.5, Project: 0.2 };
  if (!subject || !section || !['Prelim', 'Midterm', 'Final'].includes(period) || !Array.isArray(rows) || !rows.length)
    return sendError(res, 'Choose a subject, section, period, and a non-empty Excel sheet.');
  const errors = [];
  const gradeRows = [];
  for (const [index, row] of rows.entries()) {
    const studentId = String(row.StudentID || row.studentId || '').trim();
    const student = await collection('students').findOne({ studentId, section });
    if (!student) { errors.push(`Row ${index + 2}: student ${studentId || '(missing)'} is not enrolled in ${section}.`); continue; }
    const components = {};
    let valid = true;
    for (const key of Object.keys(weights)) {
      const score = Number(row[key]);
      if (row[key] === undefined || row[key] === '' || !Number.isFinite(score) || score < 0 || score > 100) {
        errors.push(`Row ${index + 2}: ${key} must be a number from 0 to 100.`);
        valid = false;
      } else components[key] = score;
    }
    if (valid) gradeRows.push({ studentId, studentName: student.name, components,
      computed: Number(Object.keys(weights).reduce((sum, key) => sum + components[key] * weights[key], 0).toFixed(2)) });
  }
  if (errors.length) return res.status(422).json({ errors });
  const assignment = await collection('teacher_assignments').findOne({ teacherEmail: req.user.email, subject, section });
  if (!assignment) return sendError(res, 'This subject and section are not assigned to your account.', 403);
  const batch = { subject, section, period, teacherEmail: req.user.email, teacherName: req.user.name, status: 'Uploaded', uploadedAt: new Date() };
  const correction = await collection('uploads').findOne({ ...batch, status: 'For Correction' });
  let uploadId;
  if (correction) {
    uploadId = correction._id;
    batch.wasCorrected = true;
    await collection('uploads').updateOne({ _id: uploadId }, { $set: batch, $push: { history: { at: new Date(), by: req.user.name, action: `Resubmitted ${gradeRows.length} corrected grades` } } });
    await collection('grades').deleteMany({ uploadId: String(uploadId) });
  } else {
    const result = await collection('uploads').insertOne({ ...batch, history: [{ at: new Date(), by: req.user.name, action: `Uploaded ${gradeRows.length} grades` }] });
    uploadId = result.insertedId;
  }
  await collection('grades').insertMany(gradeRows.map(row => ({ ...row, ...batch, uploadId: String(uploadId), status: 'Uploaded', final: null })));
  res.json({ ok: true, uploadId: String(uploadId), preview: gradeRows });
}));

app.get('/api/uploads', auth(['admin', 'adviser', 'teacher']), route(async (req, res) => {
  const filter = req.user.role === 'teacher' ? { teacherEmail: req.user.email } : req.user.role === 'adviser' ? { section: req.user.section } : {};
  const uploads = await collection('uploads').find(filter).sort({ uploadedAt: -1 }).toArray();
  for (const upload of uploads) upload.grades = await collection('grades').find({ uploadId: String(upload._id) }).toArray();
  res.json(uploads);
}));
app.get('/api/assignments', auth(['admin', 'teacher']), route(async (req, res) => {
  const filter = req.user.role === 'teacher' ? { teacherEmail: req.user.email } : {};
  res.json(await collection('teacher_assignments').find(filter).sort({ section: 1, subject: 1 }).toArray());
}));

app.put('/api/uploads/:id/:action', auth(), route(async (req, res) => {
  const id = safeId(req.params.id);
  if (!id) return sendError(res, 'Invalid upload id.');
  const upload = await collection('uploads').findOne({ _id: id });
  if (!upload) return sendError(res, 'Upload not found.', 404);
  if ((req.user.role === 'teacher' && upload.teacherEmail !== req.user.email) || (req.user.role === 'adviser' && upload.section !== req.user.section))
    return sendError(res, 'This upload is outside your assigned records.', 403);
  const actions = {
    submit: { role: 'teacher', from: ['Uploaded'], to: 'Pending Review' },
    correction: { role: 'adviser', from: ['Pending Review', 'Resubmitted'], to: 'For Correction' },
    approve: { role: 'adviser', from: ['Pending Review', 'Resubmitted'], to: 'Approved' },
    finalize: { role: 'adviser', from: ['Approved'], to: 'Finalized' }
  };
  const action = actions[req.params.action];
  if (!action || req.user.role !== action.role || !action.from.includes(upload.status)) return sendError(res, 'This workflow action is not available.', 403);
  const status = req.params.action === 'submit' && upload.status === 'Uploaded' && upload.wasCorrected ? 'Resubmitted' : action.to;
    await collection('uploads').updateOne({ _id: id }, { $set: { status }, $push: { history: { at: new Date(), by: req.user.name, action: status, note: req.body.note || '' } } });
  await collection('grades').updateMany({ uploadId: String(id) }, { $set: { status } });
  if (status === 'Finalized') {
    const grades = await collection('grades').find({ uploadId: String(id) }).toArray();
    for (const grade of grades) {
      await collection('grades').updateOne({ _id: grade._id }, { $set: { final: grade.computed, finalizedAt: new Date() } });
      await collection('report_cards').updateOne({ studentId: grade.studentId, period: upload.period },
        { $set: { studentId: grade.studentId, studentName: grade.studentName, section: upload.section, period: upload.period, status: 'Generated', generatedAt: new Date(), emailStatus: 'Not sent' } }, { upsert: true });
    }
  }
  await collection('notifications').insertOne({ to: upload.teacherEmail, message: `${upload.subject} ${upload.period}: ${status}`, at: new Date() });
  res.json({ ok: true, status });
}));

async function getGrades(user) {
  const ids = user.role === 'student' ? [user.studentId] : user.role === 'parent' ? user.children || [] : null;
  const filter = ids ? { studentId: { $in: ids }, status: 'Finalized' }
    : user.role === 'teacher' ? { teacherEmail: user.email } : user.role === 'adviser' ? { section: user.section } : {};
  return collection('grades').find(filter).sort({ period: 1, subject: 1 }).toArray();
}
app.get('/api/grades', auth(), route(async (req, res) => res.json(await getGrades(req.user))));

// ---------- Reports and local demo email delivery ----------
// Finalized grades appear on reports. "Email" is intentionally recorded in MongoDB's demo inbox.
app.get('/api/reports', auth(), route(async (req, res) => {
  let filter = {};
  if (req.user.role === 'student') filter.studentId = req.user.studentId;
  if (req.user.role === 'parent') filter.studentId = { $in: req.user.children || [] };
  if (req.user.role === 'adviser') filter.section = req.user.section;
  if (req.user.role === 'teacher') return sendError(res, 'Report cards are not available for this role.', 403);
  const reports = await collection('report_cards').find(filter).sort({ generatedAt: -1 }).toArray();
  for (const report of reports) report.grades = await collection('grades').find({ studentId: report.studentId, period: report.period, status: 'Finalized' }).toArray();
  res.json(reports);
}));
app.post('/api/reports/:id/email', auth(['admin', 'adviser']), route(async (req, res) => {
  const id = safeId(req.params.id);
  if (!id) return sendError(res, 'Invalid report id.');
  const report = await collection('report_cards').findOne({ _id: id });
  if (!report) return sendError(res, 'Report card not found.', 404);
  const student = await collection('students').findOne({ studentId: report.studentId });
  const email = { reportId: String(id), studentId: report.studentId, recipient: student?.parentEmail || student?.email || 'demo-recipient@local.test',
    subject: `${report.period} report card - ${report.studentName}`, mode: 'Local demo inbox', sentAt: new Date() };
  await collection('email_records').insertOne(email);
  await collection('report_cards').updateOne({ _id: id }, { $set: { emailStatus: 'Delivered to local demo inbox', emailedAt: email.sentAt } });
  res.json({ ok: true, delivery: email });
}));
app.get('/api/email-records', auth(['admin', 'adviser']), route(async (req, res) => res.json(await collection('email_records').find().sort({ sentAt: -1 }).limit(30).toArray())));

// ---------- Announcements, notifications, and document requests ----------
// Audience filters make notices personal; request routes let families ask for documents
// and staff update those requests.
async function visibleAnnouncements(user) {
  const sections = user.role === 'parent' ? await collection('students').distinct('section', { studentId: { $in: user.children || [] } }) : [user.section].filter(Boolean);
  const query = user.role === 'admin' ? {} : { $or: [
    { targetType: 'all' }, { targetType: 'role', targetValue: user.role },
    ...(sections.length ? [{ targetType: 'section', targetValue: { $in: sections } }] : []),
    { targetType: 'user', targetValue: user.email }
  ] };
  return collection('announcements').find(query).sort({ at: -1 }).toArray();
}
app.get('/api/announcements', auth(), route(async (req, res) => res.json(await visibleAnnouncements(req.user))));
app.post('/api/announcements', auth(['admin', 'adviser', 'teacher']), route(async (req, res) => {
  const { title, content, targetType = 'all', targetValue = '' } = req.body;
  if (!title?.trim() || !content?.trim() || !['all', 'role', 'section', 'user'].includes(targetType)) return sendError(res, 'Enter a title, message, and valid audience.');
  await collection('announcements').insertOne({ title: title.trim(), content: content.trim(), targetType, targetValue, author: req.user.name, at: new Date() });
  res.json({ ok: true });
}));
app.get('/api/notifications', auth(), route(async (req, res) => {
  const targets = [{ to: req.user.email }, { role: req.user.role }];
  if (req.user.section) targets.push({ section: req.user.section });
  const query = { $or: targets };
  res.json(await collection('notifications').find(query).sort({ at: -1 }).limit(50).toArray());
}));
app.get('/api/requests', auth(), route(async (req, res) => {
  const query = ['admin', 'adviser'].includes(req.user.role) ? {} : { userEmail: req.user.email };
  res.json(await collection('document_requests').find(query).sort({ createdAt: -1 }).toArray());
}));
app.post('/api/requests', auth(['student', 'parent']), route(async (req, res) => {
  const kinds = ['Transcript of Records', 'Good Moral Certificate', 'Enrollment Certificate', 'Other'];
  if (!kinds.includes(req.body.kind)) return sendError(res, 'Choose a valid document type.');
  await collection('document_requests').insertOne({ kind: req.body.kind, userEmail: req.user.email, userName: req.user.name,
    studentId: req.user.studentId || req.user.children?.[0], status: 'Pending', createdAt: new Date() });
  res.json({ ok: true });
}));
app.put('/api/requests/:id', auth(['admin', 'adviser']), route(async (req, res) => {
  const id = safeId(req.params.id);
  if (!id || !['Processing', 'Ready', 'Rejected'].includes(req.body.status)) return sendError(res, 'Invalid request or status.');
  const result = await collection('document_requests').updateOne({ _id: id }, { $set: { status: req.body.status, updatedAt: new Date() } });
  if (!result.matchedCount) return sendError(res, 'Request not found.', 404);
  res.json({ ok: true });
}));

// ---------- Section-scoped schedules and automatic scheduling ----------
// Schedules are filtered by role. Admin actions check overlaps before adding classes,
// generating a timetable, or choosing an available substitute.
async function getSchedules(user) {
  const parentSections = user.role === 'parent' ? await collection('students').distinct('section', { studentId: { $in: user.children || [] } }) : [];
  const filter = user.role === 'teacher' ? { $or: [{ teacherEmail: user.email }, { substituteEmail: user.email }] }
    : user.role === 'student' ? { section: user.section } : user.role === 'parent' ? { section: { $in: parentSections } }
      : user.role === 'adviser' ? { section: user.section } : {};
  return (await collection('schedules').find(filter).sort({ dayIndex: 1, start: 1 }).toArray()).map(publicSchedule);
}
app.get('/api/schedules', auth(), route(async (req, res) => res.json(await getSchedules(req.user))));
async function scheduleConflict(candidate, excludeId) {
  const existing = await collection('schedules').find({ day: candidate.day }).toArray();
  return existing.find(item => String(item._id) !== String(excludeId || '') && overlap(item, candidate) &&
    (item.section === candidate.section || item.room === candidate.room || [item.teacherEmail, item.substituteEmail].includes(candidate.teacherEmail)));
}
app.post('/api/schedules', auth(['admin']), route(async (req, res) => {
  const row = { ...req.body, dayIndex: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(req.body.day) };
  if (!row.subject || !row.section || !row.teacherEmail || !row.room || !row.day || !row.start || !row.end || row.start >= row.end)
    return sendError(res, 'Complete every schedule field and use a valid time range.');
  const conflict = await scheduleConflict(row);
  if (conflict) return res.status(409).json({ error: `Conflict: ${conflict.subject} in ${conflict.section}, ${conflict.room}, ${conflict.start}-${conflict.end}.` });
  row.substituteEmail = '';
  await collection('schedules').insertOne(row);
  res.json({ ok: true });
}));
app.post('/api/schedules/generate', auth(['admin']), route(async (req, res) => {
  const assignments = await collection('teacher_assignments').find().toArray();
  const config = await collection('config').findOne({ _id: 'system' });
  const slots = config?.timeSlots || [], days = config?.days || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  if (!assignments.length || !slots.length) return sendError(res, 'Add teacher assignments and time slots before generating.');
  const proposed = [];
  for (const assignment of assignments) {
    const teacher = await collection('teachers').findOne({ email: assignment.teacherEmail });
    const candidates = days.flatMap(day => slots.map(time => ({ ...time, day })));
    const slot = candidates.find(candidate => {
      const row = { ...candidate, ...assignment, teacherEmail: assignment.teacherEmail };
      return !proposed.some(existing => overlap(existing, row) && (existing.section === row.section || existing.room === row.room || existing.teacherEmail === row.teacherEmail)) &&
        !teacher?.unavailable?.some(item => item.day === row.day && item.start < row.end && row.start < item.end);
    });
    if (!slot) return sendError(res, `No conflict-free time slot found for ${assignment.section}: ${assignment.subject}.`);
    proposed.push({ subject: assignment.subject, section: assignment.section, teacherEmail: assignment.teacherEmail, teacherName: assignment.teacherName,
      room: assignment.room, day: slot.day, dayIndex: days.indexOf(slot.day), start: slot.start, end: slot.end, substituteEmail: '' });
  }
  await collection('schedules').deleteMany({});
  if (proposed.length) await collection('schedules').insertMany(proposed.map(row => ({ ...row, generated: true })));
  res.json({ ok: true, count: proposed.length });
}));
app.post('/api/substitute', auth(['admin', 'adviser']), route(async (req, res) => {
  const id = safeId(req.body.id), target = id && await collection('schedules').findOne({ _id: id });
  if (!target) return sendError(res, 'Scheduled class not found.', 404);
  if (target.substituteEmail) return sendError(res, 'A substitute is already assigned to this class.', 409);
  const teachers = await collection('teachers').find({ email: { $ne: target.teacherEmail } }).toArray();
  const all = await collection('schedules').find({ day: target.day }).toArray();
  const candidates = teachers.filter(teacher => !all.some(item => String(item._id) !== String(target._id) &&
    (item.teacherEmail === teacher.email || item.substituteEmail === teacher.email) && overlap(item, target)) &&
    !teacher.unavailable?.some(item => item.day === target.day && item.start < target.end && target.start < item.end));
  const workload = teacher => all.filter(item => item.teacherEmail === teacher.email || item.substituteEmail === teacher.email).length;
  candidates.sort((a, b) => Number((b.subjects || []).includes(target.subject)) - Number((a.subjects || []).includes(target.subject)) || workload(a) - workload(b));
  const substitute = candidates[0];
  if (!substitute) return sendError(res, 'No conflict-free available substitute was found.', 409);
  await collection('schedules').updateOne({ _id: target._id }, { $set: { substituteEmail: substitute.email, substituteName: substitute.name, absent: true, teacherStatus: 'Absent' } });
  const message = `${substitute.name} will cover ${target.subject}, ${target.section}, ${target.day} ${target.start}-${target.end}.`;
  const sectionStudents = await collection('students').find({ section: target.section }).toArray();
  const parents = await collection('users').find({ role: 'parent', children: { $in: sectionStudents.map(student => student.studentId) } }).toArray();
  const notices = [{ to: substitute.email, message, at: new Date() }, { to: target.teacherEmail, message, at: new Date() },
    { role: 'admin', message, at: new Date() }, { role: 'adviser', section: target.section, message, at: new Date() },
    ...sectionStudents.filter(student => student.email).map(student => ({ to: student.email, message, at: new Date() })),
    ...parents.map(parent => ({ to: parent.email, message, at: new Date() }))];
  await collection('notifications').insertMany(notices);
  res.json({ ok: true, substitute: substitute.name });
}));

// ---------- Admin CRUD and grading configuration ----------
// CRUD means Create, Read, Update, Delete. These shared routes manage allowed school records.
const ENTITIES = { students: 'students', teachers: 'teachers', sections: 'sections', subjects: 'subjects', rooms: 'rooms', users: 'users', teacher_assignments: 'teacher_assignments' };
app.get('/api/manage/:entity', auth(['admin']), route(async (req, res) => {
  const name = ENTITIES[req.params.entity];
  if (!name) return sendError(res, 'Unknown management list.', 404);
  res.json(await collection(name).find({}, { projection: name === 'users' ? { pw: 0 } : {} }).sort({ name: 1 }).toArray());
}));
app.post('/api/manage/:entity', auth(['admin']), route(async (req, res) => {
  const name = ENTITIES[req.params.entity];
  if (!name) return sendError(res, 'Unknown management list.', 404);
  const item = { ...req.body }; delete item._id;
  if (name === 'users') {
    item.email = String(item.email || '').toLowerCase();
    if (!item.email || !item.password || !['admin', 'adviser', 'teacher', 'student', 'parent'].includes(item.role)) return sendError(res, 'User email, password, and valid role are required.');
    item.pw = hash(item.password); delete item.password;
  }
  if (!item.name && name !== 'teacher_assignments') return sendError(res, 'A name is required.');
  await collection(name).insertOne(item);
  res.json({ ok: true });
}));
app.put('/api/manage/:entity/:id', auth(['admin']), route(async (req, res) => {
  const name = ENTITIES[req.params.entity], id = safeId(req.params.id);
  if (!name || !id) return sendError(res, 'Unknown record.');
  const fields = { ...req.body }; delete fields._id;
  if (name === 'users') {
    if (fields.password) fields.pw = hash(fields.password);
    delete fields.password;
  }
  const result = await collection(name).updateOne({ _id: id }, { $set: fields });
  if (!result.matchedCount) return sendError(res, 'Record not found.', 404);
  res.json({ ok: true });
}));
app.delete('/api/manage/:entity/:id', auth(['admin']), route(async (req, res) => {
  const name = ENTITIES[req.params.entity], id = safeId(req.params.id);
  if (!name || !id) return sendError(res, 'Unknown record.');
  await collection(name).deleteOne({ _id: id });
  res.json({ ok: true });
}));
app.get('/api/config', auth(), route(async (req, res) => res.json(await collection('config').findOne({ _id: 'system' }))));
app.put('/api/config', auth(['admin']), route(async (req, res) => {
  const weights = req.body.weights || {}, total = Object.values(weights).reduce((sum, value) => sum + Number(value), 0);
  if (!Object.keys(weights).length || Object.values(weights).some(value => !Number.isFinite(Number(value)) || Number(value) < 0) || Math.abs(total - 1) > 0.001)
    return sendError(res, 'Grade component weights must be non-negative and total 100%.');
  const timeSlots = req.body.timeSlots || [];
  if (timeSlots.some(slot => !/^\d{2}:\d{2}$/.test(slot.start) || !/^\d{2}:\d{2}$/.test(slot.end) || slot.start >= slot.end))
    return sendError(res, 'Every schedule slot must have a valid start time before its end time.');
  await collection('config').updateOne({ _id: 'system' }, { $set: { weights, timeSlots, days: req.body.days || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] } }, { upsert: true });
  res.json({ ok: true });
}));

// Keep API failures JSON-shaped, including malformed JSON and unknown endpoints.
app.use('/api', (error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error(error);
  sendError(res, error.type === 'entity.parse.failed' ? 'Request body contains invalid JSON.' : 'The API request could not be completed.', 400);
});
app.use('/api', (req, res) => sendError(res, `Unknown API endpoint: ${req.method} ${req.path}`, 404));

// Seed sample accounts and school data only when there are no users yet, so an existing
// database is not filled with duplicate demo records each time the server starts.
async function seed() {
  if (await collection('users').countDocuments()) return;
  const commonPassword = hash('pass123');
  const users = [
    { name: 'School Administrator', email: 'admin@sccvalenzuela.edu.ph', role: 'admin' },
    { name: 'Maria Santos', email: 'adviser@sccvalenzuela.edu.ph', role: 'adviser', section: 'Grade 10 - St. Catherine' },
    { name: 'Ramon Reyes', email: 'reyes@sccvalenzuela.edu.ph', role: 'teacher', subjects: ['Mathematics', 'Science'] },
    { name: 'Liza Cruz', email: 'cruz@sccvalenzuela.edu.ph', role: 'teacher', subjects: ['English', 'Filipino'] },
    { name: 'Paolo Mendoza', email: 'mendoza@sccvalenzuela.edu.ph', role: 'teacher', subjects: ['Science', 'Mathematics'] },
    { name: 'Juan Dela Cruz', email: 'juan@sccvalenzuela.edu.ph', role: 'student', studentId: 'SCC-2026-001', section: 'Grade 10 - St. Catherine' },
    { name: 'Ana Lopez', email: 'ana@sccvalenzuela.edu.ph', role: 'student', studentId: 'SCC-2026-002', section: 'Grade 10 - St. Catherine' },
    { name: 'Teresa Dela Cruz', email: 'parent@sccvalenzuela.edu.ph', role: 'parent', children: ['SCC-2026-001'], childSection: 'Grade 10 - St. Catherine' }
  ].map(user => ({ ...user, pw: commonPassword }));
  await collection('users').insertMany(users);
  await collection('students').insertMany([
    { studentId: 'SCC-2026-001', name: 'Juan Dela Cruz', email: 'juan@sccvalenzuela.edu.ph', section: 'Grade 10 - St. Catherine', parentEmail: 'parent@sccvalenzuela.edu.ph' },
    { studentId: 'SCC-2026-002', name: 'Ana Lopez', email: 'ana@sccvalenzuela.edu.ph', section: 'Grade 10 - St. Catherine', parentEmail: 'parent@sccvalenzuela.edu.ph' }
  ]);
  await collection('teachers').insertMany(users.filter(user => user.role === 'teacher').map(user => ({ name: user.name, email: user.email, subjects: user.subjects, workload: 2, unavailable: [] })));
  await collection('sections').insertMany([{ name: 'Grade 10 - St. Catherine', adviser: 'Maria Santos', gradeLevel: 'Grade 10' }, { name: 'Grade 9 - St. Dominic', adviser: 'Maria Santos', gradeLevel: 'Grade 9' }]);
  await collection('subjects').insertMany(['Mathematics', 'Science', 'English', 'Filipino'].map(name => ({ name })));
  await collection('rooms').insertMany([{ name: 'Room 201', capacity: 40 }, { name: 'Science Lab', capacity: 32 }, { name: 'Room 203', capacity: 40 }]);
  await collection('teacher_assignments').insertMany([
    { subject: 'Mathematics', section: 'Grade 10 - St. Catherine', teacherEmail: 'reyes@sccvalenzuela.edu.ph', teacherName: 'Ramon Reyes', room: 'Room 201' },
    { subject: 'Science', section: 'Grade 10 - St. Catherine', teacherEmail: 'reyes@sccvalenzuela.edu.ph', teacherName: 'Ramon Reyes', room: 'Science Lab' },
    { subject: 'English', section: 'Grade 10 - St. Catherine', teacherEmail: 'cruz@sccvalenzuela.edu.ph', teacherName: 'Liza Cruz', room: 'Room 203' },
    { subject: 'Filipino', section: 'Grade 10 - St. Catherine', teacherEmail: 'cruz@sccvalenzuela.edu.ph', teacherName: 'Liza Cruz', room: 'Room 201' }
  ]);
  await collection('config').insertOne({ _id: 'system', weights: { Quiz: 0.3, Exam: 0.5, Project: 0.2 }, days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    timeSlots: [{ start: '08:00', end: '09:00' }, { start: '09:15', end: '10:15' }, { start: '10:30', end: '11:30' }, { start: '13:00', end: '14:00' }] });
  await collection('schedules').insertMany([
    { subject: 'Mathematics', section: 'Grade 10 - St. Catherine', teacherEmail: 'reyes@sccvalenzuela.edu.ph', teacherName: 'Ramon Reyes', room: 'Room 201', day: 'Mon', dayIndex: 0, start: '08:00', end: '09:00', substituteEmail: '', teacherStatus: 'Absent' },
    { subject: 'Science', section: 'Grade 10 - St. Catherine', teacherEmail: 'reyes@sccvalenzuela.edu.ph', teacherName: 'Ramon Reyes', room: 'Science Lab', day: 'Mon', dayIndex: 0, start: '09:15', end: '10:15', substituteEmail: '', teacherStatus: 'Present' },
    { subject: 'English', section: 'Grade 10 - St. Catherine', teacherEmail: 'cruz@sccvalenzuela.edu.ph', teacherName: 'Liza Cruz', room: 'Room 203', day: 'Mon', dayIndex: 0, start: '08:00', end: '09:00', substituteEmail: '', teacherStatus: 'Present' },
    { subject: 'Filipino', section: 'Grade 10 - St. Catherine', teacherEmail: 'cruz@sccvalenzuela.edu.ph', teacherName: 'Liza Cruz', room: 'Room 201', day: 'Tue', dayIndex: 1, start: '08:00', end: '09:00', substituteEmail: '', teacherStatus: 'Present' }
  ]);
  const sampleBatches = [
    { subject: 'Mathematics', period: 'Prelim', teacherEmail: 'reyes@sccvalenzuela.edu.ph', teacherName: 'Ramon Reyes', status: 'Pending Review',
      grades: [{ studentId: 'SCC-2026-001', studentName: 'Juan Dela Cruz', components: { Quiz: 88, Exam: 82, Project: 90 }, computed: 85 },
        { studentId: 'SCC-2026-002', studentName: 'Ana Lopez', components: { Quiz: 92, Exam: 87, Project: 94 }, computed: 90 } ] },
    { subject: 'English', period: 'Prelim', teacherEmail: 'cruz@sccvalenzuela.edu.ph', teacherName: 'Liza Cruz', status: 'Finalized',
      grades: [{ studentId: 'SCC-2026-001', studentName: 'Juan Dela Cruz', components: { Quiz: 86, Exam: 84, Project: 92 }, computed: 86.8 },
        { studentId: 'SCC-2026-002', studentName: 'Ana Lopez', components: { Quiz: 90, Exam: 88, Project: 94 }, computed: 90 } ] }
  ];
  for (const sample of sampleBatches) {
    const batch = { subject: sample.subject, period: sample.period, teacherEmail: sample.teacherEmail, teacherName: sample.teacherName,
      section: 'Grade 10 - St. Catherine', status: sample.status, uploadedAt: new Date(), history: [{ at: new Date(), by: sample.teacherName, action: sample.status }] };
    const inserted = await collection('uploads').insertOne(batch);
    await collection('grades').insertMany(sample.grades.map(grade => ({ ...grade, ...batch, uploadId: String(inserted.insertedId),
      status: sample.status, final: sample.status === 'Finalized' ? grade.computed : null, finalizedAt: sample.status === 'Finalized' ? new Date() : null })));
    if (sample.status === 'Finalized') for (const grade of sample.grades) await collection('report_cards').updateOne(
      { studentId: grade.studentId, period: sample.period },
      { $set: { studentId: grade.studentId, studentName: grade.studentName, section: batch.section, period: sample.period,
        status: 'Generated', generatedAt: new Date(), emailStatus: 'Not sent' } }, { upsert: true });
  }
  await collection('announcements').insertOne({ title: 'Welcome to the school portal', content: 'The St. Catherine academic portal is ready for the new school year.', targetType: 'all', author: 'School Administrator', at: new Date() });
}

// Connect first; only after the database is ready do we seed sample data and open the website.
// `.then(...)` runs after a successful connection; `.catch(...)` reports a connection failure.
MongoClient.connect(MONGO_URL).then(async client => {
  db = client.db(DB_NAME);
  await seed();
  app.listen(PORT, () => console.log(`St. Catherine Academic System: http://localhost:${PORT}`));
}).catch(error => {
  console.error(`MongoDB connection failed for database "${DB_NAME}": ${error.message}`);
  process.exitCode = 1;
});