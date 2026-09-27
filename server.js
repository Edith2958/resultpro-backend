require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const teacherRoutes = require('./routes/teacher');
const studentRoutes = require('./routes/student');
const formTeacherRoutes = require('./routes/form-teacher');
const examOfficeRoutes = require('./routes/exam-office');
const termSettingsRoutes = require('./routes/term-settings');
const developerRoutes = require('./routes/developer');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public', { index: false })); // serves every page + uploaded photos; root ("/") handled below instead of defaulting to index.html

app.use('/api/teacher', teacherRoutes);
app.use('/api/student', studentRoutes);
app.use('/api/form-teacher', formTeacherRoutes);
app.use('/api/exam-office', examOfficeRoutes);
app.use('/api/term-settings', termSettingsRoutes);
app.use('/api/developer', developerRoutes);

// The homepage is now the landing page (role picker), not the raw API message.
// Every individual page (index.html, teacher.html, etc.) is still reachable directly by name.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`ResultPro API listening on port ${PORT}`));
