const express = require('express');
const multer = require('multer');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');

if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads', { recursive: true });
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- REAL-TIME UPDATES MIDDLEWARE ---
// Automatically emits a socket event whenever any API endpoint successfully modifies the database
app.use((req, res, next) => {
    const originalJson = res.json;
    res.json = function(body) {
        if (['POST', 'PUT', 'DELETE'].includes(req.method) && req.path.startsWith('/api/')) {
            if (res.statusCode >= 200 && res.statusCode < 300) {
                if (body && body.success === true && !body.isPreview) {
                    io.emit('roster_updated');
                }
            }
        }
        return originalJson.call(this, body);
    };
    next();
});

const upload = multer({ dest: 'uploads/' });
let db = new Database('database.db');

app.use(express.json());
app.use(express.static('public'));

// Configure multer for index.html replacement
const indexStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, path.join(__dirname, 'public'));
    },
    filename: function (req, file, cb) {
        cb(null, 'index.html');
    }
});
const uploadIndex = multer({ storage: indexStorage });

app.post('/api/admin/update-index', uploadIndex.single('indexfile'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded.' });
    res.json({ success: true });
});

function initDatabase() {
// --- DATABASE LAYER ---
db.exec(`
  CREATE TABLE IF NOT EXISTS staff (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    role_category TEXT DEFAULT 'Unassigned'
  );

  CREATE TABLE IF NOT EXISTS roster_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id INTEGER,
    date TEXT,
    shift_title TEXT,
    shift_time TEXT,
    status TEXT DEFAULT 'Normal',
    roster_type TEXT DEFAULT 'QA',
    UNIQUE(staff_id, date, shift_title, roster_type),
    FOREIGN KEY(staff_id) REFERENCES staff(id)
  );

  CREATE TABLE IF NOT EXISTS daily_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT,
    task_name TEXT,
    duration TEXT DEFAULT 'All Day',
    color TEXT DEFAULT 'color-1',
    shift_title TEXT,
    group_id TEXT,
    roster_type TEXT DEFAULT 'QA'
  );

  CREATE TABLE IF NOT EXISTS shift_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER,
    task_name TEXT,
    duration TEXT DEFAULT 'All Day',
    color TEXT DEFAULT 'color-1',
    group_id TEXT,
    FOREIGN KEY(entry_id) REFERENCES roster_entries(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS empty_shift_metadata (
    date TEXT,
    shift_title TEXT,
    comment TEXT,
    is_ignored INTEGER DEFAULT 0,
    manual_add INTEGER DEFAULT 0,
    roster_type TEXT DEFAULT 'QA',
    PRIMARY KEY(date, shift_title, roster_type)
  );
`);

// --- AUTOMATIC SCHEMA MIGRATION ---
try {
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='roster_entries'").get();
    if (schema && !schema.sql.includes('roster_type')) {
        console.log("--> Migrating database for multi-roster support...");
        db.transaction(() => {
            db.exec('ALTER TABLE roster_entries RENAME TO _re_old;');
            db.exec(`
                CREATE TABLE roster_entries (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    staff_id INTEGER,
                    date TEXT,
                    shift_title TEXT,
                    shift_time TEXT,
                    status TEXT DEFAULT 'Normal',
                    roster_type TEXT DEFAULT 'QA',
                    UNIQUE(staff_id, date, shift_title, roster_type),
                    FOREIGN KEY(staff_id) REFERENCES staff(id) ON DELETE CASCADE
                );
            `);
            db.exec('INSERT INTO roster_entries(id, staff_id, date, shift_title, shift_time, status) SELECT id, staff_id, date, shift_title, shift_time, status FROM _re_old;');
            db.exec('DROP TABLE _re_old;');

            db.exec('ALTER TABLE empty_shift_metadata RENAME TO _esm_old;');
            db.exec(`
                CREATE TABLE empty_shift_metadata (
                    date TEXT, shift_title TEXT, comment TEXT, is_ignored INTEGER DEFAULT 0, manual_add INTEGER DEFAULT 0,
                    roster_type TEXT DEFAULT 'QA',
                    PRIMARY KEY(date, shift_title, roster_type)
                );
            `);
            db.exec('INSERT INTO empty_shift_metadata(date, shift_title, comment, is_ignored, manual_add) SELECT date, shift_title, comment, is_ignored, manual_add FROM _esm_old;');
            db.exec('DROP TABLE _esm_old;');

            db.exec("ALTER TABLE daily_tasks ADD COLUMN roster_type TEXT DEFAULT 'QA'");
        })();
        console.log("--> Migration successful.");
    } else if (schema && !schema.sql.includes('status TEXT')) {
        console.log("--> Adding status column to roster_entries...");
        db.exec("ALTER TABLE roster_entries ADD COLUMN status TEXT DEFAULT 'Normal'");
    }
} catch (err) {
    console.error("Migration error:", err);
}

// Add task duration columns if they don't exist
try { db.exec("ALTER TABLE daily_tasks ADD COLUMN duration TEXT DEFAULT 'All Day'"); } catch(e) {}
try { db.exec("ALTER TABLE shift_tasks ADD COLUMN duration TEXT DEFAULT 'All Day'"); } catch(e) {}
try { db.exec("ALTER TABLE daily_tasks ADD COLUMN color TEXT DEFAULT 'color-1'"); } catch(e) {}
try { db.exec("ALTER TABLE shift_tasks ADD COLUMN color TEXT DEFAULT 'color-1'"); } catch(e) {}
try { db.exec("ALTER TABLE daily_tasks ADD COLUMN shift_title TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE empty_shift_metadata ADD COLUMN manual_add INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE daily_tasks ADD COLUMN group_id TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE shift_tasks ADD COLUMN group_id TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE roster_entries ADD COLUMN display_order INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE staff ADD COLUMN default_task TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE roster_entries ADD COLUMN note TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE daily_tasks ADD COLUMN display_order INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE roster_entries ADD COLUMN last_updated_at TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE roster_entries ADD COLUMN last_updated_by TEXT"); } catch(e) {}

// --- FIX DANGLING FOREIGN KEYS ---
try {
    const stSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='shift_tasks'").get();
    if (stSchema && stSchema.sql.includes('_re_old')) {
        console.log("--> Fixing corrupted shift_tasks foreign key constraint...");
        db.transaction(() => {
            db.exec('DROP TABLE IF EXISTS _st_old;');
            db.exec('ALTER TABLE shift_tasks RENAME TO _st_old;');
            db.exec(`
                CREATE TABLE shift_tasks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    entry_id INTEGER,
                    task_name TEXT,
                    duration TEXT DEFAULT 'All Day',
                    color TEXT DEFAULT 'color-1',
                    group_id TEXT,
                    FOREIGN KEY(entry_id) REFERENCES roster_entries(id) ON DELETE CASCADE
                );
            `);
            db.exec('INSERT INTO shift_tasks(id, entry_id, task_name, duration, color, group_id) SELECT id, entry_id, task_name, duration, color, group_id FROM _st_old;');
            db.exec('DROP TABLE _st_old;');
        })();
        console.log("--> Foreign key fix successful.");
    }
} catch (err) {
    console.error("FK fix error:", err);
}

    // --- AUTO-HEAL FRACTURED GROUP IDs ---
    try {
        const uniqueTaskNames = db.prepare(`
            SELECT DISTINCT task_name, roster_type FROM (
                SELECT task_name, roster_type FROM daily_tasks WHERE task_name IS NOT NULL
                UNION
                SELECT st.task_name, re.roster_type FROM shift_tasks st JOIN roster_entries re ON st.entry_id = re.id WHERE st.task_name IS NOT NULL
            )
        `).all();
        db.transaction(() => {
            const updateDaily = db.prepare("UPDATE daily_tasks SET group_id = ? WHERE task_name = ? AND roster_type IS ?");
            const updateShift = db.prepare("UPDATE shift_tasks SET group_id = ? WHERE task_name = ? AND entry_id IN (SELECT id FROM roster_entries WHERE roster_type IS ?)");
            
            for (const t of uniqueTaskNames) {
                const existing = db.prepare("SELECT group_id FROM daily_tasks WHERE task_name = ? AND roster_type IS ? AND group_id IS NOT NULL LIMIT 1").get(t.task_name, t.roster_type);
                const unifiedGroupId = existing ? existing.group_id : Date.now().toString() + Math.random().toString(36).substring(2, 7);
                
                updateDaily.run(unifiedGroupId, t.task_name, t.roster_type);
                updateShift.run(unifiedGroupId, t.task_name, t.roster_type);
            }
        })();
        console.log("--> Fractured task links successfully synchronized.");
    } catch (err) {
        console.error("Task link healing error:", err);
    }
}

initDatabase();

// Safe Date parsing supporting serials, slash, and dash notation
function parseExcelDate(cellValue) {
    if (!cellValue) return null;
    
    if (typeof cellValue === 'number' || !isNaN(cellValue)) {
        const date = XLSX.SSF.parse_date_code(Number(cellValue));
        const m = String(date.m).padStart(2, '0');
        const d = String(date.d).padStart(2, '0');
        return `${date.y}-${m}-${d}`;
    }

    const str = cellValue.toString().trim();
    const match = str.match(/(\d{4}-\d{2}-\d{2})|(\d{2}\/\d{2}\/\d{4})/);
    if (!match) return null;

    let rawDate = match[0];
    if (rawDate.includes('/')) {
        const [d, m, y] = rawDate.split('/');
        return `${y}-${m}-${d}`;
    }
    return rawDate;
}

function addDays(dateStr, days) {
    const date = new Date(dateStr + 'T12:00:00Z');
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().split('T')[0];
}

// Helper to apply default tasks and re-attach orphaned tasks
function applyDefaultTasks(isImport = false, coveredDates = null, rosterType = null) {
    if (coveredDates !== null && coveredDates.length === 0) return;
    try {
        const getShifts = db.prepare(`
            SELECT r.id, s.default_task 
            FROM roster_entries r 
            JOIN staff s ON r.staff_id = s.id 
            WHERE r.date = ? AND r.shift_title = ? AND r.roster_type = ?
        `);
        const insertShiftTask = db.prepare('INSERT INTO shift_tasks (entry_id, task_name, duration, color, group_id) VALUES (?, ?, ?, ?, ?)');
        const deleteDailyTask = db.prepare('DELETE FROM daily_tasks WHERE id = ?');
        const checkExisting = db.prepare('SELECT id FROM shift_tasks WHERE entry_id = ? AND task_name = ?');

        // 1. Re-attach orphaned tasks (Missing Assignments)
        let orphanedQueryStr = `SELECT * FROM daily_tasks WHERE shift_title IS NOT NULL`;
        let orphanedParams = [];
        
        if (coveredDates && coveredDates.length > 0) {
             const placeholders = coveredDates.map(() => '?').join(',');
             orphanedQueryStr += ` AND date IN (${placeholders})`;
             orphanedParams.push(...coveredDates);
        }
        if (rosterType) {
             orphanedQueryStr += ` AND roster_type = ?`;
             orphanedParams.push(rosterType);
        }
        
        const orphanedTasks = db.prepare(orphanedQueryStr).all(...orphanedParams);
        orphanedTasks.forEach(t => {
            const shifts = getShifts.all(t.date, t.shift_title, t.roster_type || 'QA');
            if (shifts.length > 0) {
                const targetShift = shifts.find(s => s.default_task === t.task_name);
                if (targetShift) {
                    if (!checkExisting.get(targetShift.id, t.task_name)) {
                        insertShiftTask.run(targetShift.id, t.task_name, t.duration, t.color, t.group_id);
                    }
                    deleteDailyTask.run(t.id);
                }
            }
        });

        // 2. Assign default tasks to any staff if the task exists on that day
        if (isImport) {
            let queryStr = `
                SELECT r.id, r.date, r.roster_type, s.default_task, r.staff_id, r.shift_title
                FROM roster_entries r
                JOIN staff s ON r.staff_id = s.id
                WHERE s.default_task IS NOT NULL AND s.default_task != ''
            `;
            let params = [];

            if (coveredDates && coveredDates.length > 0) {
                const placeholders = coveredDates.map(() => '?').join(',');
                queryStr += ` AND r.date IN (${placeholders})`;
                params.push(...coveredDates);
            }
            
            if (rosterType) {
                queryStr += ` AND r.roster_type = ?`;
                params.push(rosterType);
            }

            const entriesWithDefaults = db.prepare(queryStr).all(...params);

            const getTaskDetails = db.prepare(`
                SELECT task_name, duration, color, group_id FROM daily_tasks WHERE date = ? AND task_name = ? AND roster_type = ?
                UNION ALL
                SELECT st.task_name, st.duration, st.color, st.group_id FROM shift_tasks st
                JOIN roster_entries re ON st.entry_id = re.id
                WHERE re.date = ? AND st.task_name = ? AND re.roster_type = ?
                LIMIT 1
            `);

            entriesWithDefaults.forEach(e => {
                if (e.shift_title === 'QA L') {
                    return; // Skip applying default tasks to QA L shifts entirely
                }

                if (!checkExisting.get(e.id, e.default_task)) {
                    const taskInfo = getTaskDetails.get(e.date, e.default_task, e.roster_type || 'QA', e.date, e.default_task, e.roster_type || 'QA');
                    if (taskInfo) {
                        insertShiftTask.run(e.id, taskInfo.task_name, taskInfo.duration, taskInfo.color, taskInfo.group_id);
                    }
                }
            });
        }
    } catch(e) { console.error("Error applying default tasks:", e); }
}

// Helper to group shifts by their assigned tasks
function autoGroupTasksBackend(rosterType = 'QA', startDate = null, endDate = null) {
    try {
        let entries, tasks;
        if (startDate && endDate) {
            entries = db.prepare(`SELECT r.id, r.date, r.shift_title, r.display_order, s.name FROM roster_entries r JOIN staff s ON r.staff_id = s.id WHERE r.date BETWEEN ? AND ? AND r.roster_type = ?`).all(startDate, endDate, rosterType);
            tasks = db.prepare(`SELECT entry_id, task_name FROM shift_tasks WHERE entry_id IN (SELECT id FROM roster_entries WHERE date BETWEEN ? AND ? AND roster_type = ?)`).all(startDate, endDate, rosterType);
        } else {
            entries = db.prepare(`SELECT r.id, r.date, r.shift_title, r.display_order, s.name FROM roster_entries r JOIN staff s ON r.staff_id = s.id WHERE r.roster_type = ?`).all(rosterType);
            tasks = db.prepare(`SELECT entry_id, task_name FROM shift_tasks WHERE entry_id IN (SELECT id FROM roster_entries WHERE roster_type = ?)`).all(rosterType);
        }
        
        let taskRanks;
        if (startDate && endDate) {
            taskRanks = db.prepare('SELECT task_name, date FROM daily_tasks WHERE shift_title IS NULL AND date BETWEEN ? AND ? AND roster_type = ? ORDER BY date ASC, display_order ASC, id ASC').all(startDate, endDate, rosterType);
        } else {
            taskRanks = db.prepare('SELECT task_name, date FROM daily_tasks WHERE shift_title IS NULL AND roster_type = ? ORDER BY date ASC, display_order ASC, id ASC').all(rosterType);
        }
        
        const rankMap = {};
        taskRanks.forEach(r => {
            if (!rankMap[r.date]) rankMap[r.date] = {};
            if (rankMap[r.date][r.task_name] === undefined) {
                rankMap[r.date][r.task_name] = Object.keys(rankMap[r.date]).length;
            }
        });

        const taskAssignmentMap = {};
        tasks.forEach(t => {
            if (!taskAssignmentMap[t.entry_id]) taskAssignmentMap[t.entry_id] = [];
            taskAssignmentMap[t.entry_id].push(t.task_name);
        });
        
        const grouped = {};
        entries.forEach(e => {
            const key = e.date + '|' + e.shift_title;
            if (!grouped[key]) grouped[key] = [];
            e.assigned_tasks = taskAssignmentMap[e.id] || [];
            grouped[key].push(e);
        });
        
        const update = db.prepare('UPDATE roster_entries SET display_order = ? WHERE id = ?');
        db.transaction(() => {
            Object.values(grouped).forEach(group => {
                group.sort((a, b) => {
                    if (a.assigned_tasks.length > 0 && b.assigned_tasks.length === 0) return -1;
                    if (a.assigned_tasks.length === 0 && b.assigned_tasks.length > 0) return 1;
                    
                    if (a.assigned_tasks.length > 0 && b.assigned_tasks.length > 0) {
                        const taskA = a.assigned_tasks[0];
                        const taskB = b.assigned_tasks[0];
                        if (taskA !== taskB) {
                            const rankA = (rankMap[a.date] && rankMap[a.date][taskA] !== undefined) ? rankMap[a.date][taskA] : 999;
                            const rankB = (rankMap[b.date] && rankMap[b.date][taskB] !== undefined) ? rankMap[b.date][taskB] : 999;
                            if (rankA !== rankB) return rankA - rankB;
                            return taskA.localeCompare(taskB);
                        }
                    }
                    
                    return a.name.localeCompare(b.name); 
                });
                group.forEach((e, idx) => update.run(idx, e.id));
            });
        })();
    } catch (err) {
        console.error("Auto group error:", err);
        throw err;
    }
}

// --- CORE PARSING ENGINE ---
app.post('/api/upload', upload.single('roster'), (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');

    try {
        console.log("\n====================================================");
        console.log("--> INGESTION ENGINE INITIATED");
        
        const workbook = XLSX.readFile(req.file.path);
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        
        // raw: false converts formulas/numbers directly to readable display strings automatically
        const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '', raw: false });
        
        console.log(`--> Total file rows parsed into memory: ${rows.length}`);

        let currentWeekCommencing = null;
        let recordsImported = 0;
        let lastSeenRole = "";
        let lastSeenColD = "";
        let lastRoleWasQA = false;
        // Default mappings based on user layout: Mon=G(6), Tue=J(9), Wed=O(14), Thu=T(19), Fri=X(23), Sat=Z(25), Sun=E(4)
        let dayColumnIndices = [6, 9, 14, 19, 23, 25, 4];
        
        let entriesToInsert = [];
        let weeksFound = new Set();

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (!row || row.length === 0) continue;

            // Normalize row cells to strings for broad fuzzy scanning
            const stringRow = row.map(cell => cell !== undefined && cell !== null ? cell.toString().trim() : '');
            const fullRowText = stringRow.join(' ').toLowerCase();

            // --- 0. DYNAMIC DAY COLUMN DETECTION ---
            const daysRegex = [
                /^(mon|monday)(\s|$)/i,
                /^(tue|tuesday)(\s|$)/i,
                /^(wed|wednesday)(\s|$)/i,
                /^(thu|thursday)(\s|$)/i,
                /^(fri|friday)(\s|$)/i,
                /^(sat|saturday)(\s|$)/i,
                /^(sun|sunday)(\s|$)/i
            ];
            
            const foundIndices = daysRegex.map(regex => stringRow.findIndex(c => regex.test(c.trim())));
            
            // Require at least 4 day headers in the exact same row to prevent false positives from random notes
            if (foundIndices.filter(idx => idx !== -1).length >= 4) {
                foundIndices.forEach((colIdx, dayIdx) => {
                    if (colIdx !== -1) {
                        dayColumnIndices[dayIdx] = colIdx;
                    }
                });
                console.log(`[Row ${i+1}] 📅 DETECTED DAY HEADERS, updated column indices to: [${dayColumnIndices}]`);
            }

            // --- 1. ROBUST DATE ANCHOR DISCOVERY ---
            if (fullRowText.includes('week commencing')) {
                const anchorCell = stringRow.find(c => c.toLowerCase().includes('week commencing'));
                let parsedDate = parseExcelDate(anchorCell);
                
                if (parsedDate) {
                    // Force the anchor date to ALWAYS be the Monday of that week
                    // Prevents data shifting if the 'week commencing' date is typed as a Sunday
                    const d = new Date(parsedDate + 'T12:00:00Z');
                    const day = d.getUTCDay();
                    const diff = d.getUTCDate() - day + (day === 0 ? 1 : 1);
                    d.setUTCDate(diff);
                    currentWeekCommencing = d.toISOString().split('T')[0];
                    weeksFound.add(currentWeekCommencing);
                    
                    console.log(`[Row ${i+1}] 🎯 SUCCESSFULLY LOCKED BLOCK START DATE: ${currentWeekCommencing} (Parsed from: ${parsedDate})`);
                    lastSeenRole = "";
                    lastRoleWasQA = false;
                    lastSeenColD = "";
                } else {
                    console.log(`[Row ${i+1}] ⚠️ Found 'week commencing' text, but couldn't parse a valid date: "${anchorCell}"`);
                }
                continue;
            }

            // Keep looping until a block date contextual target is locked
            if (!currentWeekCommencing) continue;

            // Track the most recent Role found in Column A even outside of Q.A. target rows
            if (stringRow[0]) {
                lastSeenRole = stringRow[0];
                const currentRoleRequirement = stringRow[3] ? stringRow[3].toUpperCase().replace(/[\s\.]/g, '') : '';
                // A new role block starts.
                lastRoleWasQA = currentRoleRequirement.includes('QA');
                lastSeenColD = currentRoleRequirement;
            } else if (stringRow[3]) {
                lastSeenColD = stringRow[3].toUpperCase().replace(/[\s\.]/g, '');
            }

            // --- 2. TARGETED ROSTER FILTER CHECK ---
            // Safely check Column D (Index 3) for the specific requirement string
            // Falls back to the last seen Column D value if the cell is merged/blank
            const colD = lastSeenColD;

            const requirement = (req.body.rosterType || 'QA').toUpperCase();
            const searchReq = requirement === 'PLANNING' ? 'PLAN' : requirement;
            
            // Bypass roles that should universally appear on multiple/all rosters
            const isBypassRole = ['QA L'].includes(lastSeenRole.toUpperCase());
            
            if (!colD.includes(searchReq) && !isBypassRole) {
                continue;
            }

            // --- 3. ROW MATCH IDENTIFIED ---
            let shiftTitle = lastSeenRole || "Q.A. Duty";

            console.log(`[Row ${i+1}] 🔥 MATCHED Q.A. WORK SHEET RECORD: "${shiftTitle}"`);

            // --- 4. STREAM HORIZONTAL DAY CELLS ---
            for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
                const colIdx = dayColumnIndices[dayIdx];
                const cellContent = stringRow[colIdx];
                if (!cellContent) continue;

                const cellLines = cellContent.split(/\r?\n/);
                const staffName = cellLines[0].trim();
                const shiftTime = cellLines[1] ? cellLines[1].trim() : '';

                if (!staffName || staffName === '_' || staffName === '-') continue;

                const targetDate = addDays(currentWeekCommencing, dayIdx);

                entriesToInsert.push({ staffName, targetDate, shiftTitle, shiftTime });
            }
        }

        // Deduplicate entries to prevent identical shifts from rendering twice during previews
        const uniqueEntries = [];
        const seenEntries = new Set();
        entriesToInsert.forEach(e => {
            const key = `${e.staffName}|${e.targetDate}|${e.shiftTitle}`;
            if (!seenEntries.has(key)) {
                seenEntries.add(key);
                uniqueEntries.push(e);
            }
        });
        entriesToInsert = uniqueEntries;

        if (entriesToInsert.length === 0) {
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            return res.json({ success: true, message: 'No valid roster assignments found in the file.' });
        }

        const { mode, rosterType = 'QA' } = req.body;
        const isPreview = mode && mode.startsWith('preview_');
        const actualMode = isPreview ? mode.replace('preview_', '') : mode;

        let coveredDates = new Set();
        weeksFound.forEach(wk => {
            for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
                coveredDates.add(addDays(wk, dayIdx));
            }
        });
        const coveredDatesArr = Array.from(coveredDates);
        const placeholders = coveredDatesArr.map(() => '?').join(',');

        // If mode isn't explicitly provided, check if the period already exists
        if (!mode) {
            const existingCount = db.prepare(`SELECT COUNT(*) as count FROM roster_entries WHERE roster_type = ? AND date IN (${placeholders})`).get(rosterType, ...coveredDatesArr).count;
            if (existingCount > 0) {
                if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
                return res.json({ requiresConfirmation: true });
            }
        }

        // --- ENHANCED SUMMARY & DELETION LOGIC ---
        const existingEntries = db.prepare(`
            SELECT r.id, r.date, r.shift_title, r.shift_time, s.name as staffName
            FROM roster_entries r
            JOIN staff s ON r.staff_id = s.id
            WHERE r.date IN (${placeholders}) AND r.roster_type = ?
        `).all(...coveredDatesArr, rosterType);

        const existingTasks = db.prepare(`
            SELECT entry_id, task_name
            FROM shift_tasks
            WHERE entry_id IN (SELECT id FROM roster_entries WHERE date IN (${placeholders}) AND roster_type = ?)
        `).all(...coveredDatesArr, rosterType);

        const tasksMap = {};
        existingTasks.forEach(t => {
            if (!tasksMap[t.entry_id]) tasksMap[t.entry_id] = [];
            tasksMap[t.entry_id].push(t.task_name);
        });
        existingEntries.forEach(e => e.tasks = tasksMap[e.id] || []);

        let deletedShifts = [];
        let addedShifts = [];
        let toDeleteIds = [];

        if (actualMode === 'overwrite') {
            deletedShifts = existingEntries;
            toDeleteIds = existingEntries.map(e => e.id);
            addedShifts = entriesToInsert; // In an overwrite, all ingested rows are considered added
        } else if (actualMode === 'merge') {
            existingEntries.forEach(existing => {
                const stillExists = entriesToInsert.some(e => e.targetDate === existing.date && e.shiftTitle === existing.shift_title && e.staffName === existing.staffName);
                if (!stillExists) {
                    deletedShifts.push(existing);
                    toDeleteIds.push(existing.id);
                }
            });
            entriesToInsert.forEach(incoming => {
                const alreadyExists = existingEntries.some(e => e.date === incoming.targetDate && e.shift_title === incoming.shiftTitle && e.staffName === incoming.staffName);
                if (!alreadyExists) addedShifts.push(incoming);
            });
        } else if (actualMode === 'append' || !actualMode) {
            entriesToInsert.forEach(incoming => {
                const alreadyExists = existingEntries.some(e => e.date === incoming.targetDate && e.shift_title === incoming.shiftTitle && e.staffName === incoming.staffName);
                if (!alreadyExists) addedShifts.push(incoming);
            });
        }

        if (isPreview) {
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            return res.json({
                isPreview: true,
                previewData: {
                    added: addedShifts.map(s => ({
                        date: s.targetDate,
                        staff: s.staffName,
                        role: s.shiftTitle,
                        shift_time: s.shiftTime
                    })),
                    deleted: deletedShifts.map(s => ({ ...s, entry_id: s.id, staff: s.staffName, role: s.shift_title }))
                }
            });
        }

        let recoveredTasks = [];

        if (toDeleteIds.length > 0) {
            const placeholders = toDeleteIds.map(() => '?').join(',');

            // Safely recover orphaned tasks during a merge and move them to the unassigned pool
            if (actualMode === 'merge') {
                const tasksToRecover = db.prepare(`
                    SELECT st.task_name, st.duration, st.color, st.group_id, re.date, re.shift_title, s.name as staffName
                    FROM shift_tasks st
                    JOIN roster_entries re ON st.entry_id = re.id
                    JOIN staff s ON re.staff_id = s.id
                    WHERE st.entry_id IN (${placeholders})
                `).all(...toDeleteIds);

                if (tasksToRecover.length > 0) {
                    const insertRecoveredTask = db.prepare(`INSERT INTO daily_tasks (date, task_name, duration, color, shift_title, group_id, roster_type) VALUES (?, ?, ?, ?, ?, ?, ?)`);
                    tasksToRecover.forEach(t => {
                        insertRecoveredTask.run(t.date, t.task_name, t.duration, t.color, t.shift_title, t.group_id, rosterType);
                        recoveredTasks.push(t);
                    });
                }
            }

            db.prepare(`DELETE FROM shift_tasks WHERE entry_id IN (${placeholders})`).run(...toDeleteIds);
            db.prepare(`DELETE FROM roster_entries WHERE id IN (${placeholders})`).run(...toDeleteIds);
        }

        const insertStaff = db.prepare('INSERT OR IGNORE INTO staff (name) VALUES (?)');
        const getStaff = db.prepare('SELECT id FROM staff WHERE name = ?');
        const insertEntry = db.prepare(`
            INSERT INTO roster_entries (staff_id, date, shift_title, shift_time, roster_type, last_updated_at, last_updated_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(staff_id, date, shift_title, roster_type) DO UPDATE SET
                shift_time = excluded.shift_time,
                last_updated_at = excluded.last_updated_at,
                last_updated_by = excluded.last_updated_by
        `);

        const transaction = db.transaction((entries) => {
            const ts = new Date().toISOString();
            const un = os.userInfo().username || 'Unknown';
            for (const e of entries) {
                insertStaff.run(e.staffName);
                const staffRow = getStaff.get(e.staffName);
                insertEntry.run(staffRow.id, e.targetDate, e.shiftTitle, e.shiftTime, rosterType, ts, un);
                recordsImported++;
            }
        });

        transaction(entriesToInsert);
        applyDefaultTasks(true, coveredDatesArr, rosterType);
        autoGroupTasksBackend(rosterType);

        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        
        console.log(`--> Ingestion Run finished. Saved rows added to SQLite: ${recordsImported}`);
        console.log("====================================================\n");
        
        res.json({ 
            success: true, 
            message: `Successfully processed ${recordsImported} total Excel roster assignments.`,
            summary: {
                deleted: deletedShifts.map(s => ({
                    date: s.date,
                    staff: s.staffName,
                    role: s.shift_title,
                    tasks: s.tasks
                })),
                added: addedShifts.map(s => ({
                    date: s.targetDate,
                    staff: s.staffName,
                    role: s.shiftTitle
                })),
                recoveredTasks: recoveredTasks.map(t => ({
                    date: t.date,
                    task: t.task_name,
                    role: t.shift_title,
                    originalStaff: t.staffName
                }))
            }
        });

    } catch (err) {
        console.error("\n❌ PARSER EXCEPTION FAILURE CAUGHT:", err);
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Internal processing error parsing the Excel layout structure.' });
    }
});

// --- API: APPLY PREVIEW CHANGES (NEW) ---
app.post('/api/upload/apply', (req, res) => {
    const { mode, added, deleted, rosterType = 'QA' } = req.body;
    
    try {
        let recordsImported = 0;
        let recoveredTasks = [];

        const toDeleteIds = (deleted || []).map(d => d.entry_id).filter(id => id);

        if (toDeleteIds.length > 0) {
            const placeholders = toDeleteIds.map(() => '?').join(',');

            // Safely recover orphaned tasks during a merge
            if (mode === 'merge') {
                const tasksToRecover = db.prepare(`
                    SELECT st.task_name, st.duration, st.color, st.group_id, re.date, re.shift_title, s.name as staffName
                    FROM shift_tasks st
                    JOIN roster_entries re ON st.entry_id = re.id
                    JOIN staff s ON re.staff_id = s.id
                    WHERE st.entry_id IN (${placeholders})
                `).all(...toDeleteIds);

                if (tasksToRecover.length > 0) {
                    const insertRecoveredTask = db.prepare(`INSERT INTO daily_tasks (date, task_name, duration, color, shift_title, group_id, roster_type) VALUES (?, ?, ?, ?, ?, ?, ?)`);
                    tasksToRecover.forEach(t => {
                        insertRecoveredTask.run(t.date, t.task_name, t.duration, t.color, t.shift_title, t.group_id, rosterType);
                        recoveredTasks.push(t);
                    });
                }
            }

            db.prepare(`DELETE FROM shift_tasks WHERE entry_id IN (${placeholders})`).run(...toDeleteIds);
            db.prepare(`DELETE FROM roster_entries WHERE id IN (${placeholders})`).run(...toDeleteIds);
        }

        const insertStaff = db.prepare('INSERT OR IGNORE INTO staff (name) VALUES (?)');
        const getStaff = db.prepare('SELECT id FROM staff WHERE name = ?');
        const insertEntry = db.prepare(`
            INSERT INTO roster_entries (staff_id, date, shift_title, shift_time, roster_type, last_updated_at, last_updated_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(staff_id, date, shift_title, roster_type) DO UPDATE SET
                shift_time = excluded.shift_time,
                last_updated_at = excluded.last_updated_at,
                last_updated_by = excluded.last_updated_by
        `);

        const transaction = db.transaction((entries) => {
            const ts = new Date().toISOString();
            const un = os.userInfo().username || 'Unknown';
            for (const e of entries) {
                insertStaff.run(e.staff_name);
                const staffRow = getStaff.get(e.staff_name);
                insertEntry.run(staffRow.id, e.date, e.shift_title, e.shift_time || '', rosterType, ts, un);
                recordsImported++;
            }
        });

        transaction(added || []);
        const affectedDates = [...new Set((added || []).map(a => a.date))];
        applyDefaultTasks(true, affectedDates, rosterType);
        autoGroupTasksBackend(rosterType);

        res.json({
            success: true,
            message: `Preview changes applied: ${recordsImported} added, ${toDeleteIds.length} removed.`
        });
    } catch (err) {
        console.error("Apply preview error:", err);
        res.status(500).json({ error: 'Failed to apply preview changes.' });
    }
});

// --- API: DATABASE EXPORT/IMPORT ---
app.get('/api/database/export', (req, res) => {
    const { rosterType = 'QA' } = req.query;
    try {
        db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (e) {
        console.error("Checkpoint error:", e);
    }
    const tempFile = `database_export_${Date.now()}.db`;
    try {
        fs.copyFileSync('database.db', tempFile);
        const tempDb = new Database(tempFile);
        tempDb.prepare('DELETE FROM roster_entries WHERE roster_type != ?').run(rosterType);
        tempDb.prepare('DELETE FROM daily_tasks WHERE roster_type != ?').run(rosterType);
        tempDb.prepare('DELETE FROM empty_shift_metadata WHERE roster_type != ?').run(rosterType);
        tempDb.prepare('DELETE FROM shift_tasks WHERE entry_id NOT IN (SELECT id FROM roster_entries)').run();
        tempDb.exec('VACUUM;');
        tempDb.close();
        res.download(tempFile, `${rosterType}_Roster_Backup_${new Date().toISOString().split('T')[0]}.db`, (err) => {
            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        });
    } catch (err) {
        console.error(err);
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        res.status(500).json({ error: 'Failed to export database.' });
    }
});

app.get('/api/database/export/tasks', (req, res) => {
    try {
        db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (e) {
        console.error("Checkpoint error:", e);
    }
    
    const tempFile = `database_tasks_${Date.now()}.db`;
    try {
        fs.copyFileSync('database.db', tempFile);
        const tempDb = new Database(tempFile);
        
        const { startDate, endDate, rosterType = 'QA' } = req.query;
        
        let dateFilter = 'WHERE roster_type = ?';
        let params = [rosterType];
        if (startDate && endDate) {
            dateFilter += ' AND date BETWEEN ? AND ?';
            params.push(startDate, endDate);
        }
        
        // Consolidate all tasks into unique daily unassigned tasks
        const allUniqueTasks = tempDb.prepare(`
            WITH ranked_tasks AS (
                SELECT
                    id, date, task_name, duration, color, group_id, roster_type, display_order, priority,
                    ROW_NUMBER() OVER (
                        PARTITION BY date, task_name, roster_type
                        ORDER BY
                            priority ASC,
                            CASE WHEN group_id IS NOT NULL THEN 0 ELSE 1 END,
                            CASE WHEN duration = 'All Day' THEN 0 ELSE 1 END,
                            id DESC
                    ) as rn
                FROM (
                    SELECT id, date, task_name, duration, color, group_id, roster_type, display_order, 1 as priority FROM daily_tasks
                    UNION ALL
                    SELECT st.id, re.date, st.task_name, st.duration, st.color, st.group_id, re.roster_type, 0 as display_order, 2 as priority
                    FROM shift_tasks st
                    JOIN roster_entries re ON st.entry_id = re.id
                )
                ${dateFilter}
            )
            SELECT date, task_name, duration, color, group_id, roster_type, display_order
            FROM ranked_tasks
            WHERE rn = 1
            ORDER BY date ASC, display_order ASC, priority ASC, id ASC
        `).all(...params);

        tempDb.exec('DELETE FROM daily_tasks;');
        
        if (allUniqueTasks.length > 0) {
            const insertTask = tempDb.prepare(`INSERT INTO daily_tasks (date, task_name, duration, color, group_id, roster_type, display_order) VALUES (?, ?, ?, ?, ?, ?, ?)`);
            allUniqueTasks.forEach(t => {
                insertTask.run(t.date, t.task_name, t.duration, t.color, t.group_id, t.roster_type || rosterType, t.display_order !== null ? t.display_order : 0);
            });
        }

        tempDb.exec('DELETE FROM empty_shift_metadata;');
        tempDb.exec('DELETE FROM shift_tasks;');
        tempDb.exec('DELETE FROM roster_entries;');
        tempDb.exec('VACUUM;');
        tempDb.close();

        let filename = `${rosterType}_Roster_Tasks_Only_${new Date().toISOString().split('T')[0]}.db`;
        if (startDate && endDate) {
            filename = `${rosterType}_Roster_Weekly_Tasks_${startDate}_to_${endDate}.db`;
        }

        res.download(tempFile, filename, (err) => {
            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        });
    } catch (err) {
        console.error("Database task export error:", err);
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        res.status(500).json({ error: 'Failed to export tasks database.' });
    }
});

app.post('/api/database/import', upload.single('database'), (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');
    const { rosterType = 'QA' } = req.query;
    try {
        const uploadedDb = new Database(req.file.path);
        
        try {
            const schema = uploadedDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='roster_entries'").get();
            if (schema && !schema.sql.includes('roster_type')) {
                uploadedDb.exec("ALTER TABLE roster_entries ADD COLUMN roster_type TEXT DEFAULT 'QA'");
                uploadedDb.exec("ALTER TABLE daily_tasks ADD COLUMN roster_type TEXT DEFAULT 'QA'");
                uploadedDb.exec("ALTER TABLE empty_shift_metadata ADD COLUMN roster_type TEXT DEFAULT 'QA'");
            }
            if (schema && !schema.sql.includes('note')) {
                uploadedDb.exec("ALTER TABLE roster_entries ADD COLUMN note TEXT");
            }
        } catch(e) {}
        try {
            const schema = uploadedDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='roster_entries'").get();
            if (schema && !schema.sql.includes('last_updated_at')) { uploadedDb.exec("ALTER TABLE roster_entries ADD COLUMN last_updated_at TEXT"); uploadedDb.exec("ALTER TABLE roster_entries ADD COLUMN last_updated_by TEXT"); }
        } catch(e) {}

        try {
            const schemaStaff = uploadedDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='staff'").get();
            if (schemaStaff && !schemaStaff.sql.includes('default_task')) {
                uploadedDb.exec("ALTER TABLE staff ADD COLUMN default_task TEXT");
            }
        } catch(e) {}
        
        db.transaction(() => {
            db.prepare('DELETE FROM shift_tasks WHERE entry_id IN (SELECT id FROM roster_entries WHERE roster_type = ?)').run(rosterType);
            db.prepare('DELETE FROM roster_entries WHERE roster_type = ?').run(rosterType);
            db.prepare('DELETE FROM daily_tasks WHERE roster_type = ?').run(rosterType);
            db.prepare('DELETE FROM empty_shift_metadata WHERE roster_type = ?').run(rosterType);

            const importEntries = uploadedDb.prepare('SELECT * FROM roster_entries WHERE roster_type = ?').all(rosterType);
            const insertEntry = db.prepare('INSERT INTO roster_entries (staff_id, date, shift_title, shift_time, status, note, roster_type, display_order, last_updated_at, last_updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
            const insertStaff = db.prepare('INSERT OR IGNORE INTO staff (name, role_category, default_task) VALUES (?, ?, ?)');
            const updateStaffDefault = db.prepare('UPDATE staff SET default_task = ? WHERE name = ? AND default_task IS NULL');
            const getStaffByName = db.prepare('SELECT id FROM staff WHERE name = ?');
            
            const entryIdMap = {};
            for (const e of importEntries) {
                const staffInUpload = uploadedDb.prepare('SELECT * FROM staff WHERE id = ?').get(e.staff_id);
                if (staffInUpload) {
                    insertStaff.run(staffInUpload.name, staffInUpload.role_category, staffInUpload.default_task);
                    if (staffInUpload.default_task) updateStaffDefault.run(staffInUpload.default_task, staffInUpload.name);
                    const localStaff = getStaffByName.get(staffInUpload.name);
                    const result = insertEntry.run(localStaff.id, e.date, e.shift_title, e.shift_time, e.status, e.note, e.roster_type, e.display_order, e.last_updated_at, e.last_updated_by);
                    entryIdMap[e.id] = result.lastInsertRowid;
                }
            }

            if (Object.keys(entryIdMap).length > 0) {
                const shiftTasks = uploadedDb.prepare('SELECT st.* FROM shift_tasks st JOIN roster_entries re ON st.entry_id = re.id WHERE re.roster_type = ?').all(rosterType);
                const insertShiftTask = db.prepare('INSERT INTO shift_tasks (entry_id, task_name, duration, color, group_id) VALUES (?, ?, ?, ?, ?)');
                for (const st of shiftTasks) {
                    if (entryIdMap[st.entry_id]) {
                        insertShiftTask.run(entryIdMap[st.entry_id], st.task_name, st.duration, st.color, st.group_id);
                    }
                }
            }

            const dailyTasks = uploadedDb.prepare('SELECT * FROM daily_tasks WHERE roster_type = ? ORDER BY date ASC, display_order ASC, id ASC').all(rosterType);
            const insertDailyTask = db.prepare('INSERT INTO daily_tasks (date, task_name, duration, color, shift_title, group_id, roster_type, display_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
            for (const dt of dailyTasks) {
                insertDailyTask.run(dt.date, dt.task_name, dt.duration, dt.color, dt.shift_title, dt.group_id, dt.roster_type, dt.display_order !== null ? dt.display_order : 0);
            }

            const metadata = uploadedDb.prepare('SELECT * FROM empty_shift_metadata WHERE roster_type = ?').all(rosterType);
            const insertMetadata = db.prepare('INSERT INTO empty_shift_metadata (date, shift_title, comment, is_ignored, manual_add, roster_type) VALUES (?, ?, ?, ?, ?, ?)');
            for (const md of metadata) {
                insertMetadata.run(md.date, md.shift_title, md.comment, md.is_ignored, md.manual_add, md.roster_type);
            }
        })();

        uploadedDb.close();
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.json({ success: true, message: 'Database imported successfully.' });
    } catch (err) {
        console.error("Database import error:", err);
        res.status(500).json({ error: 'Failed to import database.' });
    }
});

// --- API: IMPORT TASKS DATABASE ---
app.post('/api/database/import/tasks', upload.single('database'), (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');
    const { mode, targetDate, weeks = 1, conflict = 'append', rosterType = 'QA' } = req.query;
    
    try {
        const uploadedDb = new Database(req.file.path);
        const tasksToImport = uploadedDb.prepare('SELECT * FROM daily_tasks ORDER BY date ASC, display_order ASC, id ASC').all();
        
        if (tasksToImport.length > 0) {
            const insertTask = db.prepare('INSERT INTO daily_tasks (date, task_name, duration, color, group_id, roster_type, display_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
            
            let diffDays = 0;
            let numWeeks = 1;
            
            if (mode === 'template' && targetDate) {
                numWeeks = parseInt(weeks) || 1;
                const targetMonday = new Date(targetDate + 'T12:00:00Z');
                let minDateStr = tasksToImport.reduce((min, t) => t.date < min ? t.date : min, tasksToImport[0].date);
                const minD = new Date(minDateStr + 'T12:00:00Z');
                const day = minD.getUTCDay();
                const diff = minD.getUTCDate() - day + (day === 0 ? -6 : 1);
                minD.setUTCDate(diff);
                
                const diffTime = targetMonday.getTime() - minD.getTime();
                diffDays = Math.round(diffTime / (1000 * 3600 * 24));
                
                if (conflict === 'overwrite') {
                    const endDate = new Date(targetDate + 'T12:00:00Z');
                    endDate.setUTCDate(endDate.getUTCDate() + (numWeeks * 7) - 1);
                    const endDateStr = endDate.toISOString().split('T')[0];

                    db.prepare(`
                        DELETE FROM shift_tasks 
                        WHERE entry_id IN (
                            SELECT id FROM roster_entries WHERE date BETWEEN ? AND ? AND roster_type = ?
                        )
                    `).run(targetDate, endDateStr, rosterType);
                    
                    db.prepare('DELETE FROM daily_tasks WHERE date BETWEEN ? AND ? AND roster_type = ?').run(targetDate, endDateStr, rosterType);
                }
            }
            
            db.transaction(() => {
                const groupMap = {}; // Maintain group ID links across all replicated weeks
                for (let w = 0; w < numWeeks; w++) {
                    tasksToImport.forEach(t => {
                        const tDate = new Date(t.date + 'T12:00:00Z');
                        tDate.setUTCDate(tDate.getUTCDate() + diffDays + (w * 7));
                        const newDateStr = tDate.toISOString().split('T')[0];
                        
                        let newGroupId = t.group_id;
                        if (t.group_id) {
                            if (!groupMap[t.group_id]) {
                                groupMap[t.group_id] = Date.now().toString() + Math.random().toString(36).substring(2, 7);
                            }
                            newGroupId = groupMap[t.group_id];
                        }
                        
                        insertTask.run(newDateStr, t.task_name, t.duration, t.color, newGroupId, rosterType, t.display_order !== null ? t.display_order : 0);
                    });
                }
            })();
        }
        
        uploadedDb.close();
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        
        res.json({ success: true, message: 'Tasks imported successfully.' });
    } catch (err) {
        console.error("Task import error:", err);
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Failed to import tasks.' });
    }
});

// --- API: RETRIEVE ROSTER DASHBOARD DATA (UPDATED to include entry ID) ---
app.get('/api/roster', (req, res) => {
    const { startDate, endDate, rosterType = 'QA' } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: 'Missing date bounds.' });

    // Added r.id as 'entry_id' so the front-end can target rows for on-the-fly modifications
    const data = db.prepare(`
        SELECT r.id as entry_id, r.date, r.shift_title, r.shift_time, r.status, r.note, r.display_order, r.last_updated_at, r.last_updated_by, s.name as staff_name, s.role_category
        FROM roster_entries r
        JOIN staff s ON r.staff_id = s.id
        WHERE r.date BETWEEN ? AND ? AND r.roster_type = ?
        ORDER BY r.date ASC, r.display_order ASC, s.name ASC
    `).all(startDate, endDate, rosterType);
    
    const entryIds = data.map(d => d.entry_id);
    if (entryIds.length > 0) {
        const placeholders = entryIds.map(() => '?').join(',');
        const tasks = db.prepare(`SELECT * FROM shift_tasks WHERE entry_id IN (${placeholders})`).all(...entryIds);
        
        const taskRanks = db.prepare('SELECT task_name, date FROM daily_tasks WHERE shift_title IS NULL AND date BETWEEN ? AND ? AND roster_type = ? ORDER BY date ASC, display_order ASC, id ASC').all(startDate, endDate, rosterType);
        const rankMap = {};
        taskRanks.forEach(r => {
            if (!rankMap[r.date]) rankMap[r.date] = {};
            if (rankMap[r.date][r.task_name] === undefined) {
                rankMap[r.date][r.task_name] = Object.keys(rankMap[r.date]).length;
            }
        });

        const taskMap = {};
        tasks.forEach(t => {
            if (!taskMap[t.entry_id]) taskMap[t.entry_id] = [];
            taskMap[t.entry_id].push(t);
        });
        
        data.forEach(d => {
            const dayTasks = taskMap[d.entry_id] || [];
            dayTasks.sort((a, b) => {
                const rankA = (rankMap[d.date] && rankMap[d.date][a.task_name] !== undefined) ? rankMap[d.date][a.task_name] : 999;
                const rankB = (rankMap[d.date] && rankMap[d.date][b.task_name] !== undefined) ? rankMap[d.date][b.task_name] : 999;
                if (rankA !== rankB) return rankA - rankB;
                return a.task_name.localeCompare(b.task_name);
            });
            d.assigned_tasks = dayTasks;
        });
    } else {
        data.forEach(d => d.assigned_tasks = []);
    }
    
    res.json(data);
});

// --- API: UPDATE SPECIFIC SHIFT ROLE ON THE FLY (NEW) ---
app.post('/api/roster/shift', (req, res) => {
    const { entry_id, new_shift_title } = req.body;
    
    try {
        const update = db.prepare('UPDATE roster_entries SET shift_title = ?, last_updated_at = ?, last_updated_by = ? WHERE id = ?');
        const result = update.run(new_shift_title, new Date().toISOString(), os.userInfo().username || 'Unknown', entry_id);
        
        if (result.changes > 0) {
            res.json({ success: true, message: 'Shift role updated successfully.' });
        } else {
            res.status(444).json({ error: 'Roster entry target not found.' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database update failed.' });
    }
});

// --- API: UPDATE SPECIFIC SHIFT TIME (NEW) ---
app.post('/api/roster/shift/time', (req, res) => {
    const { entry_id, new_shift_time } = req.body;
    try {
        db.prepare('UPDATE roster_entries SET shift_time = ?, last_updated_at = ?, last_updated_by = ? WHERE id = ?').run(new_shift_time, new Date().toISOString(), os.userInfo().username || 'Unknown', entry_id);
        res.json({ success: true, message: 'Shift time updated successfully.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database update failed.' });
    }
});

// --- API: UPDATE SPECIFIC SHIFT STATUS (NEW) ---
app.post('/api/roster/shift/status', (req, res) => {
    const { entry_id, status } = req.body;
    try {
        db.prepare('UPDATE roster_entries SET status = ?, last_updated_at = ?, last_updated_by = ? WHERE id = ?').run(status, new Date().toISOString(), os.userInfo().username || 'Unknown', entry_id);
        res.json({ success: true, message: 'Shift status updated successfully.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database update failed.' });
    }
});

// --- API: UPDATE SPECIFIC SHIFT NOTE (NEW) ---
app.post('/api/roster/shift/note', (req, res) => {
    const { entry_id, note } = req.body;
    try {
        db.prepare('UPDATE roster_entries SET note = ?, last_updated_at = ?, last_updated_by = ? WHERE id = ?').run(note, new Date().toISOString(), os.userInfo().username || 'Unknown', entry_id);
        res.json({ success: true, message: 'Shift note updated successfully.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database update failed.' });
    }
});

// --- API: DUPLICATE SHIFT VIA COPY/PASTE (NEW) ---
app.post('/api/roster/shift/duplicate', (req, res) => {
    const { source_entry_id, new_date, new_shift_title } = req.body;
    try {
        const source = db.prepare('SELECT * FROM roster_entries WHERE id = ?').get(source_entry_id);
        if (!source) return res.status(404).json({ error: 'Source shift not found.' });
        
        db.prepare(`
            INSERT INTO roster_entries (staff_id, date, shift_title, shift_time, status, roster_type, last_updated_at, last_updated_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(source.staff_id, new_date, new_shift_title, source.shift_time, source.status, source.roster_type, new Date().toISOString(), os.userInfo().username || 'Unknown');
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            res.status(400).json({ error: 'Staff member is already scheduled for this specific role on this date.' });
        } else {
            res.status(500).json({ error: 'Database insertion failed.' });
        }
    }
});

// --- API: SWAP SHIFT USER ---
app.post('/api/roster/shift/swap', (req, res) => {
    const { entry_id, new_staff_name } = req.body;
    try {
        const staff = db.prepare('SELECT id FROM staff WHERE name = ?').get(new_staff_name);
        if (!staff) return res.status(404).json({ error: 'Staff not found.' });
        db.prepare('UPDATE roster_entries SET staff_id = ?, last_updated_at = ?, last_updated_by = ? WHERE id = ?').run(staff.id, new Date().toISOString(), os.userInfo().username || 'Unknown', entry_id);
        res.json({ success: true });
    } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            res.status(400).json({ error: 'Staff member is already scheduled for this role on this date.' });
        } else {
            res.status(500).json({ error: 'Failed to swap user.' });
        }
    }
});

// --- API: MOVE SHIFT VIA DRAG AND DROP ---
app.post('/api/roster/shift/move', (req, res) => {
    const { entry_id, new_date, new_shift_title, source_task, target_task } = req.body;
    try {
        let changesMade = false;
        db.transaction(() => {
            const update = db.prepare('UPDATE roster_entries SET date = ?, shift_title = ?, last_updated_at = ?, last_updated_by = ? WHERE id = ?');
            const result = update.run(new_date, new_shift_title, new Date().toISOString(), os.userInfo().username || 'Unknown', entry_id);
            
            if (result.changes > 0) {
                changesMade = true;
                if (source_task && target_task && source_task !== target_task) {
                    const rosterType = db.prepare('SELECT roster_type FROM roster_entries WHERE id = ?').get(entry_id).roster_type;

                    const assignedTasks = db.prepare('SELECT id, task_name FROM shift_tasks WHERE entry_id = ?').all(entry_id);
                    
                    if (assignedTasks.length > 0) {
                        const taskRanks = db.prepare('SELECT task_name FROM daily_tasks WHERE shift_title IS NULL AND date = ? AND roster_type = ? ORDER BY display_order ASC, id ASC').all(new_date, rosterType);
                        const rankMap = {};
                        taskRanks.forEach((r, i) => { rankMap[r.task_name] = i; });

                        assignedTasks.sort((a, b) => {
                            const rankA = rankMap[a.task_name] !== undefined ? rankMap[a.task_name] : 999;
                            const rankB = rankMap[b.task_name] !== undefined ? rankMap[b.task_name] : 999;
                            if (rankA !== rankB) return rankA - rankB;
                            return a.task_name.localeCompare(b.task_name);
                        });

                        const firstTask = assignedTasks[0];
                        if (firstTask.task_name === source_task) {
                             db.prepare('DELETE FROM shift_tasks WHERE id = ?').run(firstTask.id);
                        }
                    }
                    
                    if (target_task !== 'Unassigned') {
                        const taskDetailsQuery = `
                            SELECT color, duration, group_id FROM (
                                SELECT color, duration, group_id, 1 as p FROM daily_tasks WHERE date = ? AND task_name = ? AND roster_type = ? AND shift_title IS NULL
                                UNION ALL
                                SELECT st.color, st.duration, st.group_id, 2 as p FROM shift_tasks st JOIN roster_entries re ON st.entry_id = re.id WHERE re.date = ? AND st.task_name = ? AND re.roster_type = ?
                            ) ORDER BY p ASC LIMIT 1
                        `;
                        const taskDetails = db.prepare(taskDetailsQuery).get(new_date, target_task, rosterType, new_date, target_task, rosterType);

                        if (taskDetails) {
                             const existing = db.prepare('SELECT id FROM shift_tasks WHERE entry_id = ? AND task_name = ?').get(entry_id, target_task);
                             if (!existing) {
                                db.prepare('INSERT INTO shift_tasks (entry_id, task_name, duration, color, group_id) VALUES (?, ?, ?, ?, ?)').run(entry_id, target_task, taskDetails.duration, taskDetails.color, taskDetails.group_id);
                             }
                        }
                    }
                }
                applyDefaultTasks();
            }
        })();

        if (changesMade) res.json({ success: true, message: 'Shift moved successfully.' });
        else res.status(404).json({ error: 'Roster entry not found.' });
    } catch (err) {
        // The database schema prevents duplicate identical roles for the same staff member on the exact same date
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            res.status(400).json({ error: 'Staff member is already scheduled for this specific role on this date.' });
        } else {
            res.status(500).json({ error: 'Database update failed.' });
        }
    }
});

// --- API: REORDER SHIFTS WITHIN ROLE ---
app.post('/api/roster/shift/reorder', (req, res) => {
    const { entry_ids } = req.body;
    try {
        const update = db.prepare('UPDATE roster_entries SET display_order = ? WHERE id = ?');
        const transaction = db.transaction((ids) => {
            ids.forEach((id, index) => {
                update.run(index, id);
            });
        });
        transaction(entry_ids || []);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to reorder shifts.' });
    }
});

// --- API: AUTO-GROUP TASKS ---
app.post('/api/roster/auto-group-tasks', (req, res) => {
    const { startDate, endDate, rosterType = 'QA' } = req.body;
    try {
        autoGroupTasksBackend(rosterType, startDate, endDate);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to auto-group tasks.' });
    }
});

// --- API: DAILY TASKS ---
app.get('/api/tasks', (req, res) => {
    const { startDate, endDate, rosterType = 'QA' } = req.query;
    const tasks = db.prepare(`SELECT * FROM daily_tasks WHERE roster_type = ? AND date BETWEEN ? AND ? ORDER BY date ASC, display_order ASC, id ASC`).all(rosterType, startDate, endDate);
    res.json(tasks);
});

app.post('/api/tasks', (req, res) => {
    const { date, task_name, duration = 'All Day', color = 'color-1', group_id = null, rosterType = 'QA' } = req.body;
    try {
        db.prepare('INSERT INTO daily_tasks (date, task_name, duration, color, group_id, roster_type) VALUES (?, ?, ?, ?, ?, ?)').run(date, task_name, duration, color, group_id, rosterType);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to add task.' });
    }
});

app.post('/api/tasks/move-vertical', (req, res) => {
    const { taskId, direction, mode } = req.body;
    try {
        const task = db.prepare('SELECT * FROM daily_tasks WHERE id = ?').get(taskId);
        if (!task) return res.status(404).json({ error: 'Task not found.' });

        let datesToUpdate = [task.date];
        if (mode === 'all' && task.group_id) {
            const linkedTasks = db.prepare('SELECT DISTINCT date FROM daily_tasks WHERE group_id = ?').all(task.group_id);
            datesToUpdate = linkedTasks.map(t => t.date);
        }

        db.transaction(() => {
            for (const date of datesToUpdate) {
                let tasksOnDay;
                if (!task.shift_title) {
                    tasksOnDay = db.prepare('SELECT id FROM daily_tasks WHERE date = ? AND roster_type = ? AND shift_title IS NULL ORDER BY display_order ASC, id ASC').all(date, task.roster_type);
                } else {
                    tasksOnDay = db.prepare('SELECT id FROM daily_tasks WHERE date = ? AND roster_type = ? AND shift_title = ? ORDER BY display_order ASC, id ASC').all(date, task.roster_type, task.shift_title);
                }
                const idsOnDay = tasksOnDay.map(t => t.id);
                
                let taskToMoveOnThisDay;
                if (!task.shift_title) {
                    taskToMoveOnThisDay = db.prepare('SELECT id FROM daily_tasks WHERE date = ? AND task_name = ? AND roster_type = ? AND shift_title IS NULL').get(date, task.task_name, task.roster_type);
                } else {
                    taskToMoveOnThisDay = db.prepare('SELECT id FROM daily_tasks WHERE date = ? AND task_name = ? AND roster_type = ? AND shift_title = ?').get(date, task.task_name, task.roster_type, task.shift_title);
                }
                
                if (!taskToMoveOnThisDay) continue;

                const currentIndex = idsOnDay.indexOf(taskToMoveOnThisDay.id);
                if (currentIndex === -1) continue;

                if (direction === 'up' && currentIndex > 0) {
                    [idsOnDay[currentIndex], idsOnDay[currentIndex - 1]] = [idsOnDay[currentIndex - 1], idsOnDay[currentIndex]];
                } else if (direction === 'down' && currentIndex < idsOnDay.length - 1) {
                    [idsOnDay[currentIndex], idsOnDay[currentIndex + 1]] = [idsOnDay[currentIndex + 1], idsOnDay[currentIndex]];
                } else {
                    continue;
                }

                const update = db.prepare('UPDATE daily_tasks SET display_order = ? WHERE id = ?');
                idsOnDay.forEach((id, index) => {
                    update.run(index, id);
                });
            }
        })();
        res.json({ success: true });
    } catch (err) {
        console.error("Task move vertical error:", err);
        res.status(500).json({ error: 'Failed to move task.' });
    }
});

app.post('/api/tasks/edit', (req, res) => {
    const { task_id, task_type, new_task_name, mode = 'all' } = req.body;
    try {
        let task;
        if (task_type === 'daily') {
            task = db.prepare('SELECT task_name, date, group_id, roster_type FROM daily_tasks WHERE id = ?').get(task_id);
        } else {
            task = db.prepare('SELECT st.task_name, re.date, st.group_id, re.roster_type FROM shift_tasks st JOIN roster_entries re ON st.entry_id = re.id WHERE st.id = ?').get(task_id);
        }

        if (task) {
            if (task.group_id && mode === 'all') {
                db.prepare('UPDATE daily_tasks SET task_name = ? WHERE group_id = ?').run(new_task_name, task.group_id);
                db.prepare('UPDATE shift_tasks SET task_name = ? WHERE group_id = ?').run(new_task_name, task.group_id);
            } else if (mode === 'single') {
                if (task_type === 'daily') {
                    db.prepare('UPDATE daily_tasks SET task_name = ? WHERE id = ?').run(new_task_name, task_id);
                } else {
                    db.prepare('UPDATE shift_tasks SET task_name = ? WHERE id = ?').run(new_task_name, task_id);
                }
            } else {
                db.prepare('UPDATE daily_tasks SET task_name = ? WHERE task_name = ? AND date = ? AND roster_type = ?').run(new_task_name, task.task_name, task.date, task.roster_type || 'QA');
                db.prepare('UPDATE shift_tasks SET task_name = ? WHERE task_name = ? AND entry_id IN (SELECT id FROM roster_entries WHERE date = ? AND roster_type = ?)').run(new_task_name, task.task_name, task.date, task.roster_type || 'QA');
            }
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to edit task.' });
    }
});

app.post('/api/tasks/duration', (req, res) => {
    const { task_id, duration, mode = 'all' } = req.body;
    try {
        const task = db.prepare('SELECT task_name, date, group_id, roster_type FROM daily_tasks WHERE id = ?').get(task_id);
        if (task) {
            if (task.group_id && mode === 'all') {
                db.prepare('UPDATE daily_tasks SET duration = ? WHERE group_id = ?').run(duration, task.group_id);
                db.prepare('UPDATE shift_tasks SET duration = ? WHERE group_id = ?').run(duration, task.group_id);
            } else if (mode === 'single') {
                db.prepare('UPDATE daily_tasks SET duration = ? WHERE id = ?').run(duration, task_id);
            } else {
                db.prepare('UPDATE daily_tasks SET duration = ? WHERE task_name = ? AND date = ? AND roster_type = ?').run(duration, task.task_name, task.date, task.roster_type || 'QA');
                db.prepare('UPDATE shift_tasks SET duration = ? WHERE task_name = ? AND entry_id IN (SELECT id FROM roster_entries WHERE date = ? AND roster_type = ?)').run(duration, task.task_name, task.date, task.roster_type || 'QA');
            }
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update task duration.' });
    }
});

app.post('/api/tasks/color', (req, res) => {
    const { task_id, color, mode = 'all' } = req.body;
    try {
        const task = db.prepare('SELECT task_name, date, group_id, roster_type FROM daily_tasks WHERE id = ?').get(task_id);
        if (task) {
            if (task.group_id && mode === 'all') {
                db.prepare('UPDATE daily_tasks SET color = ? WHERE group_id = ?').run(color, task.group_id);
                db.prepare('UPDATE shift_tasks SET color = ? WHERE group_id = ?').run(color, task.group_id);
            } else if (mode === 'single') {
                db.prepare('UPDATE daily_tasks SET color = ? WHERE id = ?').run(color, task_id);
            } else {
                db.prepare('UPDATE daily_tasks SET color = ? WHERE task_name = ? AND date = ? AND roster_type = ?').run(color, task.task_name, task.date, task.roster_type || 'QA');
                db.prepare('UPDATE shift_tasks SET color = ? WHERE task_name = ? AND entry_id IN (SELECT id FROM roster_entries WHERE date = ? AND roster_type = ?)').run(color, task.task_name, task.date, task.roster_type || 'QA');
            }
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update task color.' });
    }
});

// --- API: ASSIGN/MOVE TASK ON SHIFT ---
app.post('/api/roster/shift/task', (req, res) => {
    const { entry_id, task_name, duration = 'All Day', color = 'color-1', group_id = null } = req.body;
    try {
        const existing = db.prepare('SELECT id FROM shift_tasks WHERE entry_id = ? AND task_name = ?').get(entry_id, task_name);
        if (existing) {
            return res.status(400).json({ error: 'Task is already assigned to this staff member.' });
        }

        db.prepare('INSERT INTO shift_tasks (entry_id, task_name, duration, color, group_id) VALUES (?, ?, ?, ?, ?)').run(entry_id, task_name, duration, color, group_id);
        try { db.prepare('UPDATE roster_entries SET last_updated_at = ?, last_updated_by = ? WHERE id = ?').run(new Date().toISOString(), os.userInfo().username || 'Unknown', entry_id); } catch(e) {}
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to assign task to shift.' });
    }
});

app.post('/api/roster/shift/task/move', (req, res) => {
    const { shift_task_id, new_entry_id } = req.body;
    try {
        const taskToMove = db.prepare('SELECT task_name FROM shift_tasks WHERE id = ?').get(shift_task_id);
        if (taskToMove) {
            const existing = db.prepare('SELECT id FROM shift_tasks WHERE entry_id = ? AND task_name = ?').get(new_entry_id, taskToMove.task_name);
            if (existing) {
                return res.status(400).json({ error: 'Task is already assigned to this staff member.' });
            }
        }

        db.prepare('UPDATE shift_tasks SET entry_id = ? WHERE id = ?').run(new_entry_id, shift_task_id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to move task.' });
    }
});

app.post('/api/roster/shift/task/duration', (req, res) => {
    const { shift_task_id, duration, mode = 'all' } = req.body;
    try {
        const shiftTask = db.prepare('SELECT st.task_name, re.date, st.group_id, re.roster_type FROM shift_tasks st JOIN roster_entries re ON st.entry_id = re.id WHERE st.id = ?').get(shift_task_id);
        if (shiftTask) {
            if (shiftTask.group_id && mode === 'all') {
                db.prepare('UPDATE daily_tasks SET duration = ? WHERE group_id = ?').run(duration, shiftTask.group_id);
                db.prepare('UPDATE shift_tasks SET duration = ? WHERE group_id = ?').run(duration, shiftTask.group_id);
            } else if (mode === 'single') {
                db.prepare('UPDATE shift_tasks SET duration = ? WHERE id = ?').run(duration, shift_task_id);
            } else {
                db.prepare('UPDATE daily_tasks SET duration = ? WHERE task_name = ? AND date = ? AND roster_type = ?').run(duration, shiftTask.task_name, shiftTask.date, shiftTask.roster_type || 'QA');
                db.prepare('UPDATE shift_tasks SET duration = ? WHERE task_name = ? AND entry_id IN (SELECT id FROM roster_entries WHERE date = ? AND roster_type = ?)').run(duration, shiftTask.task_name, shiftTask.date, shiftTask.roster_type || 'QA');
            }
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update task duration.' });
    }
});

app.post('/api/roster/shift/task/color', (req, res) => {
    const { shift_task_id, color, mode = 'all' } = req.body;
    try {
        const shiftTask = db.prepare('SELECT st.task_name, re.date, st.group_id, re.roster_type FROM shift_tasks st JOIN roster_entries re ON st.entry_id = re.id WHERE st.id = ?').get(shift_task_id);
        if (shiftTask) {
            if (shiftTask.group_id && mode === 'all') {
                db.prepare('UPDATE daily_tasks SET color = ? WHERE group_id = ?').run(color, shiftTask.group_id);
                db.prepare('UPDATE shift_tasks SET color = ? WHERE group_id = ?').run(color, shiftTask.group_id);
            } else if (mode === 'single') {
                db.prepare('UPDATE shift_tasks SET color = ? WHERE id = ?').run(color, shift_task_id);
            } else {
                db.prepare('UPDATE daily_tasks SET color = ? WHERE task_name = ? AND date = ? AND roster_type = ?').run(color, shiftTask.task_name, shiftTask.date, shiftTask.roster_type || 'QA');
                db.prepare('UPDATE shift_tasks SET color = ? WHERE task_name = ? AND entry_id IN (SELECT id FROM roster_entries WHERE date = ? AND roster_type = ?)').run(color, shiftTask.task_name, shiftTask.date, shiftTask.roster_type || 'QA');
            }
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update task color.' });
    }
});

app.delete('/api/data/clear', (req, res) => {
    const { startDate, endDate, rosterType = 'QA', type = 'tasks', scope = 'week' } = req.query;

    try {
        db.transaction(() => {
            let dateCondition = '';
            let params = [rosterType];
            
            if (scope === 'week') {
                if (!startDate || !endDate) throw new Error('Missing date bounds.');
                dateCondition = ' AND date BETWEEN ? AND ?';
                params.push(startDate, endDate);
            } else if (scope === 'future') {
                if (!startDate) throw new Error('Missing start date.');
                dateCondition = ' AND date >= ?';
                params.push(startDate);
            }

            if (type === 'tasks' || type === 'both') {
                db.prepare(`
                    DELETE FROM shift_tasks 
                    WHERE entry_id IN (
                        SELECT id FROM roster_entries WHERE roster_type = ?${dateCondition}
                    )
                `).run(...params);
                
                db.prepare(`DELETE FROM daily_tasks WHERE roster_type = ?${dateCondition}`).run(...params);
            }

            if (type === 'shifts') {
                const tasksToRecover = db.prepare(`
                    SELECT st.task_name, st.duration, st.color, st.group_id, re.date, re.shift_title
                    FROM shift_tasks st
                    JOIN roster_entries re ON st.entry_id = re.id
                    WHERE re.roster_type = ?${dateCondition}
                `).all(...params);

                if (tasksToRecover.length > 0) {
                    const insertRecoveredTask = db.prepare(`INSERT INTO daily_tasks (date, task_name, duration, color, shift_title, group_id, roster_type) VALUES (?, ?, ?, ?, ?, ?, ?)`);
                    tasksToRecover.forEach(t => {
                        insertRecoveredTask.run(t.date, t.task_name, t.duration, t.color, t.shift_title, t.group_id, rosterType);
                    });
                }
                
                db.prepare(`
                    DELETE FROM shift_tasks 
                    WHERE entry_id IN (
                        SELECT id FROM roster_entries WHERE roster_type = ?${dateCondition}
                    )
                `).run(...params);
            }

            if (type === 'shifts' || type === 'both') {
                db.prepare(`DELETE FROM roster_entries WHERE roster_type = ?${dateCondition}`).run(...params);
                db.prepare(`DELETE FROM empty_shift_metadata WHERE roster_type = ?${dateCondition}`).run(...params);
            }
        })();
        res.json({ success: true });
    } catch (err) {
        console.error("Clear data error:", err);
        res.status(500).json({ error: 'Failed to clear data.' });
    }
});

app.delete('/api/tasks/:id', (req, res) => {
    try {
        const mode = req.query.mode || 'all';
        const task = db.prepare('SELECT * FROM daily_tasks WHERE id = ?').get(req.params.id);
        if (task) {
            if (task.group_id && mode === 'all') {
                db.prepare('DELETE FROM shift_tasks WHERE group_id = ?').run(task.group_id);
                db.prepare('DELETE FROM daily_tasks WHERE group_id = ?').run(task.group_id);
            } else {
                // Only cascade delete to all users and missing assignments if it's a top-level Daily Task
                if (!task.shift_title) {
                    db.prepare(`
                        DELETE FROM shift_tasks 
                        WHERE task_name = ? AND entry_id IN (
                            SELECT id FROM roster_entries WHERE date = ? AND roster_type = ?
                        )
                    `).run(task.task_name, task.date, task.roster_type || 'QA');
                    db.prepare('DELETE FROM daily_tasks WHERE task_name = ? AND date = ? AND id != ? AND roster_type = ?').run(task.task_name, task.date, task.id, task.roster_type || 'QA');
                }
                db.prepare('DELETE FROM daily_tasks WHERE id = ?').run(req.params.id);
            }
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete task.' });
    }
});

app.delete('/api/roster/shift/task/:id', (req, res) => {
    try {
        const mode = req.query.mode || 'single';
        const shiftTask = db.prepare('SELECT entry_id, group_id FROM shift_tasks WHERE id = ?').get(req.params.id);
        if (mode === 'all' && shiftTask && shiftTask.group_id) {
            db.prepare('DELETE FROM shift_tasks WHERE group_id = ?').run(shiftTask.group_id);
            db.prepare('DELETE FROM daily_tasks WHERE group_id = ?').run(shiftTask.group_id);
        } else {
            db.prepare('DELETE FROM shift_tasks WHERE id = ?').run(req.params.id);
            if (shiftTask) { try { db.prepare('UPDATE roster_entries SET last_updated_at = ?, last_updated_by = ? WHERE id = ?').run(new Date().toISOString(), os.userInfo().username || 'Unknown', shiftTask.entry_id); } catch(e) {} }
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to remove assigned task.' });
    }
});

// --- API: DELETE SPECIFIC SHIFT (NEW) ---
app.delete('/api/roster/shift/:id', (req, res) => {
    const entryId = req.params.id;
    
    try {
        db.prepare('DELETE FROM shift_tasks WHERE entry_id = ?').run(entryId);
        const result = db.prepare('DELETE FROM roster_entries WHERE id = ?').run(entryId);
        if (result.changes > 0) {
            res.json({ success: true, message: 'Shift deleted successfully.' });
        } else {
            res.status(404).json({ error: 'Roster entry not found.' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database deletion failed.' });
    }
});

app.get('/api/tasks/unique', (req, res) => {
    try {
        const tasks = db.prepare(`
            SELECT DISTINCT task_name 
            FROM (
                SELECT task_name FROM daily_tasks
                UNION
                SELECT task_name FROM shift_tasks
            ) 
            WHERE task_name IS NOT NULL
            ORDER BY task_name ASC
        `).all();
        res.json(tasks);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch unique tasks.' });
    }
});

app.post('/api/staff/defaults', (req, res) => {
    const { updates } = req.body;
    if (!Array.isArray(updates)) return res.status(400).json({ error: 'Invalid payload' });
    
    try {
        const updateStmt = db.prepare('UPDATE staff SET default_task = ? WHERE id = ?');
        db.transaction(() => {
            for (const u of updates) {
                updateStmt.run(u.default_task || null, u.id);
            }
        })();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update defaults.' });
    }
});

// --- API: METADATA & STAFF ---
app.get('/api/staff', (req, res) => {
    const staff = db.prepare('SELECT * FROM staff ORDER BY name ASC').all();
    res.json(staff);
});

app.post('/api/staff', (req, res) => {
    const { name } = req.body;
    try {
        db.prepare('INSERT INTO staff (name) VALUES (?)').run(name);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: 'Staff member already exists or invalid name.' });
    }
});

app.put('/api/staff/:id', (req, res) => {
    const { name } = req.body;
    try {
        db.prepare('UPDATE staff SET name = ? WHERE id = ?').run(name, req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: 'Update failed. Name might already exist.' });
    }
});

app.delete('/api/staff/:id', (req, res) => {
    try {
        const staffId = req.params.id;
        db.prepare('DELETE FROM shift_tasks WHERE entry_id IN (SELECT id FROM roster_entries WHERE staff_id = ?)').run(staffId);
        db.prepare('DELETE FROM roster_entries WHERE staff_id = ?').run(staffId);
        db.prepare('DELETE FROM staff WHERE id = ?').run(staffId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete staff member.' });
    }
});

app.get('/api/metadata', (req, res) => {
    const { startDate, endDate } = req.query;
    const data = db.prepare(`SELECT * FROM empty_shift_metadata WHERE date BETWEEN ? AND ?`).all(startDate, endDate);
    res.json(data);
});

app.post('/api/metadata/comment', (req, res) => {
    const { date, shift_title, comment, rosterType = 'QA' } = req.body;
    try {
        db.prepare(`
            INSERT INTO empty_shift_metadata (date, shift_title, comment, roster_type) VALUES (?, ?, ?, ?)
            ON CONFLICT(date, shift_title, roster_type) DO UPDATE SET comment = excluded.comment
        `).run(date, shift_title, comment, rosterType);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save comment.' });
    }
});

app.post('/api/metadata/ignore', (req, res) => {
    const { date, shift_title, is_ignored, rosterType = 'QA' } = req.body;
    try {
        db.prepare(`
            INSERT INTO empty_shift_metadata (date, shift_title, is_ignored, roster_type) VALUES (?, ?, ?, ?)
            ON CONFLICT(date, shift_title, roster_type) DO UPDATE SET is_ignored = excluded.is_ignored
        `).run(date, shift_title, is_ignored, rosterType);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update ignore status.' });
    }
});

app.post('/api/roster/shift/assign', (req, res) => {
    const { staff_name, date, shift_title, rosterType = 'QA' } = req.body;
    try {
        const staff = db.prepare('SELECT id FROM staff WHERE name = ?').get(staff_name);
        if (!staff) return res.status(404).json({ error: 'Staff not found.' });
        db.prepare(`
            INSERT INTO roster_entries (staff_id, date, shift_title, shift_time, roster_type, last_updated_at, last_updated_by)
            VALUES (?, ?, ?, '', ?, ?, ?)
        `).run(staff.id, date, shift_title, rosterType, new Date().toISOString(), os.userInfo().username || 'Unknown');
        applyDefaultTasks();
        res.json({ success: true });
    } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            res.status(400).json({ error: 'Staff member is already scheduled for this role on this date.' });
        } else {
            res.status(500).json({ error: 'Failed to assign user.' });
        }
    }
});

app.post('/api/metadata/manual', (req, res) => {
    const { date, shift_title, amount, rosterType = 'QA' } = req.body;
    try {
        const amt = parseInt(amount) || 0;
        db.prepare(`
            INSERT INTO empty_shift_metadata (date, shift_title, manual_add, roster_type) VALUES (?, ?, ?, ?)
            ON CONFLICT(date, shift_title, roster_type) DO UPDATE SET manual_add = empty_shift_metadata.manual_add + ?
        `).run(date, shift_title, amt, rosterType, amt);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update manual missing assignment.' });
    }
});

app.post('/api/tasks/assign_missing', (req, res) => {
    const { task_id, task_type, date, shift_title, task_name, duration, color, group_id, rosterType = 'QA' } = req.body;
    try {
        if (task_type === 'daily') {
            db.prepare('INSERT INTO daily_tasks (date, task_name, duration, color, shift_title, group_id, roster_type) VALUES (?, ?, ?, ?, ?, ?, ?)').run(date, task_name, duration, color, shift_title, group_id, rosterType);
        } else if (task_type === 'assigned') {
            const task = db.prepare('SELECT * FROM shift_tasks WHERE id = ?').get(task_id);
            if (task) {
                db.prepare('INSERT INTO daily_tasks (date, task_name, duration, color, shift_title, group_id, roster_type) VALUES (?, ?, ?, ?, ?, ?, ?)').run(date, task.task_name, task.duration, task.color, shift_title, task.group_id, rosterType);
                db.prepare('DELETE FROM shift_tasks WHERE id = ?').run(task_id);
            }
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to assign task.' });
    }
});

// --- API: STATISTICS ---
app.get('/api/statistics', (req, res) => {
    const { rosterType = 'QA', timeRange = 'all' } = req.query;
    try {
        const statuses = db.prepare(`SELECT status, COUNT(*) as count FROM roster_entries WHERE status IN ('Sick', 'Unavailable', 'WFH') AND roster_type = ? GROUP BY status`).all(rosterType);
        const taskAllocation = db.prepare(`SELECT s.name, COUNT(st.id) as count FROM shift_tasks st JOIN roster_entries r ON st.entry_id = r.id JOIN staff s ON r.staff_id = s.id WHERE r.roster_type = ? GROUP BY s.name ORDER BY count DESC LIMIT 10`).all(rosterType);
        const manualMissing = db.prepare(`SELECT SUM(manual_add) as count FROM empty_shift_metadata WHERE is_ignored = 0 AND roster_type = ?`).get(rosterType).count || 0;
        const totalIgnored = db.prepare(`SELECT COUNT(*) as count FROM empty_shift_metadata WHERE is_ignored = 1 AND roster_type = ?`).get(rosterType).count || 0;
        const roleCounts = db.prepare(`SELECT shift_title, COUNT(*) as count FROM roster_entries WHERE roster_type = ? GROUP BY shift_title ORDER BY count DESC LIMIT 10`).all(rosterType);

        function calculateHours(shiftTime) {
            if (!shiftTime) return 7.5;
            const str = shiftTime.toLowerCase().replace(/\s+/g, '');
            const match = str.match(/(\d{1,2})[:\.]?(\d{2})?(am|pm)?-(\d{1,2})[:\.]?(\d{2})?(am|pm)?/);
            if (match) {
                let h1 = parseInt(match[1]), m1 = parseInt(match[2]||'0'), p1 = match[3];
                let h2 = parseInt(match[4]), m2 = parseInt(match[5]||'0'), p2 = match[6];
                
                if (p1 === 'pm' && h1 < 12) h1 += 12;
                if (p1 === 'am' && h1 === 12) h1 = 0;
                if (!p1 && h1 < 6) h1 += 12;
                if (p2 === 'pm' && h2 < 12) h2 += 12;
                if (p2 === 'am' && h2 === 12) h2 = 0;
                if (!p2 && h2 < 12 && h2 <= h1) h2 += 12;

                let diff = (h2 + m2/60) - (h1 + m1/60);
                if (diff >= 6) diff -= 0.5;
                return diff > 0 ? diff : 7.5;
            }
            return 7.5;
        }

        const taskHoursMap = {};
        const allShiftTasks = db.prepare(`SELECT st.task_name, re.shift_time FROM shift_tasks st JOIN roster_entries re ON st.entry_id = re.id WHERE re.roster_type = ?`).all(rosterType);
        allShiftTasks.forEach(st => {
            const hrs = calculateHours(st.shift_time);
            if (!taskHoursMap[st.task_name]) taskHoursMap[st.task_name] = 0;
            taskHoursMap[st.task_name] += hrs;
        });
        const taskHours = Object.keys(taskHoursMap).map(k => ({ task: k, hours: taskHoursMap[k] })).sort((a, b) => b.hours - a.hours);

        const weeklyStatsMap = {};
        const allEntries = db.prepare(`SELECT date, shift_time, status FROM roster_entries WHERE roster_type = ?`).all(rosterType);
        allEntries.forEach(re => {
            const d = new Date(re.date + 'T12:00:00Z');
            const day = d.getUTCDay();
            const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
            d.setUTCDate(diff);
            const weekCommencing = d.toISOString().split('T')[0];
            
            if (!weeklyStatsMap[weekCommencing]) weeklyStatsMap[weekCommencing] = { hours: 0, wfh: 0, sick: 0, unavailable: 0 };
            
            if (re.status === 'WFH') {
                weeklyStatsMap[weekCommencing].wfh++;
                weeklyStatsMap[weekCommencing].hours += calculateHours(re.shift_time);
            } else if (re.status === 'Sick') {
                weeklyStatsMap[weekCommencing].sick++;
            } else if (re.status === 'Unavailable') {
                weeklyStatsMap[weekCommencing].unavailable++;
            } else {
                weeklyStatsMap[weekCommencing].hours += calculateHours(re.shift_time);
            }
        });
        
        const sortedWeeks = Object.keys(weeklyStatsMap).sort();
        const rosterHoursOverTime = sortedWeeks.map(w => ({ week: w, hours: weeklyStatsMap[w].hours }));
        const statusOverTime = sortedWeeks.map(w => ({ 
            week: w, wfh: weeklyStatsMap[w].wfh, sick: weeklyStatsMap[w].sick, unavailable: weeklyStatsMap[w].unavailable 
        }));

        // Apply variable time range dynamically
        let userTaskDateFilter = '';
        if (timeRange !== 'all') {
            const months = parseInt(timeRange);
            if (!isNaN(months)) {
                userTaskDateFilter = ` AND re.date >= date('now', '-${months} months')`;
            }
        }
        
        const userTasksMap = {};
        const userTotalHoursMap = {};
        const weeklyTaskStats = {};

        const allUserEntries = db.prepare(`
            SELECT re.id, s.name as userName, re.shift_time, re.status, re.date
            FROM roster_entries re
            JOIN staff s ON re.staff_id = s.id
            WHERE re.roster_type = ? AND re.status NOT IN ('Sick', 'Unavailable') ${userTaskDateFilter}
        `).all(rosterType);

        const shiftTasksData = db.prepare(`SELECT entry_id, task_name FROM shift_tasks`).all();
        const tasksByEntry = {};
        shiftTasksData.forEach(st => {
            if (!tasksByEntry[st.entry_id]) tasksByEntry[st.entry_id] = [];
            tasksByEntry[st.entry_id].push(st.task_name);
        });

        allUserEntries.forEach(row => {
            const userName = row.userName;
            const shiftHours = calculateHours(row.shift_time);
            
            if (!userTasksMap[userName]) userTasksMap[userName] = {};
            if (!userTotalHoursMap[userName]) userTotalHoursMap[userName] = 0;
            
            userTotalHoursMap[userName] += shiftHours;
            
            const d = new Date(row.date + 'T12:00:00Z');
            const day = d.getUTCDay();
            const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
            d.setUTCDate(diff);
            const weekCommencing = d.toISOString().split('T')[0];
            
            if (!weeklyTaskStats[weekCommencing]) weeklyTaskStats[weekCommencing] = {};

            const tasks = tasksByEntry[row.id] || [];
            if (tasks.length === 0) {
                if (!userTasksMap[userName]['Unassigned']) userTasksMap[userName]['Unassigned'] = 0;
                userTasksMap[userName]['Unassigned'] += shiftHours;
            } else {
                const hoursPerTask = shiftHours / tasks.length;
                tasks.forEach(taskName => {
                    if (!userTasksMap[userName][taskName]) userTasksMap[userName][taskName] = 0;
                    userTasksMap[userName][taskName] += hoursPerTask;
                    
                    if (!weeklyTaskStats[weekCommencing][taskName]) weeklyTaskStats[weekCommencing][taskName] = 0;
                    weeklyTaskStats[weekCommencing][taskName] += hoursPerTask;
                });
            }
        });

        const userTasks = Object.keys(userTasksMap).map(user => {
            return {
                user,
                totalHours: userTotalHoursMap[user],
                tasks: Object.keys(userTasksMap[user]).map(task => ({
                    task,
                    hours: userTasksMap[user][task]
                })).sort((a, b) => b.hours - a.hours)
            };
        }).sort((a, b) => a.user.localeCompare(b.user));

        res.json({ 
            success: true, statuses, taskAllocation, manualMissing, totalIgnored, roleCounts,
            taskHours, rosterHoursOverTime, statusOverTime, userTasks, weeklyTaskStats
        });
    } catch (err) {
        console.error("Statistics error:", err);
        res.status(500).json({ success: false, error: 'Failed to generate statistics.' });
    }
});

app.use((err, req, res, next) => {
    console.error("Unhandled Server Error:", err.message || err);
    res.status(500).json({ error: 'An unexpected server error occurred.' });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`QA Roster Server running on port ${PORT}`);
});