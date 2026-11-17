
require('dotenv').config();
const mongoose = require('mongoose');

const collections = [
  'users',
  'students',
  'teachers',
  'sections',
  'subjects',
  'grades',
  'schedules',
  'announcements',
  'report_cards',
  'notifications',
  'document_requests',
  'config'
];

async function initializeDatabase() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);

    const db = mongoose.connection.db;

    for (const name of collections) {
      const exists = await db.listCollections({ name }).hasNext();

      if (!exists) {
        await db.createCollection(name);
        console.log(`Created collection: ${name}`);
      } else {
        console.log(`Already exists: ${name}`);
      }
    }

    console.log('Database initialization complete!');
  } catch (error) {
    console.error('Database initialization failed:', error.message);
  } finally {
    await mongoose.disconnect();
  }
}

initializeDatabase();
