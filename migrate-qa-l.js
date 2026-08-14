const Database = require('better-sqlite3');
const fs = require('fs');

const dbPath = process.argv[2];

if (!dbPath) {
    console.error('Please provide the path to the exported database file.');
    console.error('Usage: node migrate-qa-l.js <path_to_db_file>');
    process.exit(1);
}

if (!fs.existsSync(dbPath)) {
    console.error(`File not found: ${dbPath}`);
    process.exit(1);
}

try {
    const db = new Database(dbPath);
    console.log(`Migrating 'QA L' roles to 'Universal' in database: ${dbPath}`);

    try {
        const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='roster_entries'").get();
        if (schema && !schema.sql.includes('roster_type')) {
            console.log("Adding missing roster_type column for older schema compatibility...");
            db.exec("ALTER TABLE roster_entries ADD COLUMN roster_type TEXT DEFAULT 'QA'");
            db.exec("ALTER TABLE daily_tasks ADD COLUMN roster_type TEXT DEFAULT 'QA'");
            db.exec("ALTER TABLE empty_shift_metadata ADD COLUMN roster_type TEXT DEFAULT 'QA'");
        }
    } catch(e) {}

    db.transaction(() => {
        const rosterResult = db.prepare("UPDATE roster_entries SET roster_type = 'Universal' WHERE shift_title = 'QA L' AND roster_type != 'Universal'").run();
        console.log(`- Updated ${rosterResult.changes} rows in roster_entries`);
        const metaResult = db.prepare("UPDATE empty_shift_metadata SET roster_type = 'Universal' WHERE shift_title = 'QA L' AND roster_type != 'Universal'").run();
        console.log(`- Updated ${metaResult.changes} rows in empty_shift_metadata`);
        const tasksResult = db.prepare("UPDATE daily_tasks SET roster_type = 'Universal' WHERE shift_title = 'QA L' AND roster_type != 'Universal'").run();
        console.log(`- Updated ${tasksResult.changes} rows in daily_tasks`);
    })();
    db.close();
    console.log('Migration completed successfully. You can now import this database into the main app.');
} catch (err) {
    console.error('An error occurred during migration:', err);
}