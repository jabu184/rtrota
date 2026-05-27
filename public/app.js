let allAvailableStaff = [];
let isLightTheme = false;
let isAdmin = false;
let currentRoster = 'QA';
let isDailyTasksHidden = true;

// --- PREVIEW STATE ---
let previewState = {
    active: false,
    added: [],
    deleted: [],
    mode: null
};

// --- SELECTION STATE ---
let selectedShifts = new Set();

function setSelectionVisuals(entryId, isSelected) {
    if (String(entryId).startsWith('empty|')) {
        const parts = String(entryId).split('|');
        document.querySelectorAll('.empty-chip').forEach(c => {
            if (c.getAttribute('data-date') === parts[1] && c.getAttribute('data-role') === parts[2]) {
                isSelected ? c.classList.add('selected-shift') : c.classList.remove('selected-shift');
            }
        });
    } else {
        const el = document.querySelector(`[data-entry-id='${entryId}']`);
        if (el) isSelected ? el.classList.add('selected-shift') : el.classList.remove('selected-shift');
    }
}

function clearSelection() {
    selectedShifts.forEach(id => {
        const el = document.querySelector(`[data-entry-id='${id}']`);
        if (el) el.classList.remove('selected-shift');
    });
    document.querySelectorAll('.selected-shift').forEach(el => el.classList.remove('selected-shift'));
    selectedShifts.clear();
}

function getAffectedShifts(clickedChip) {
    if (selectedShifts.size > 0) {
        const arr = Array.from(selectedShifts);
        if (clickedChip) {
            let entryId = clickedChip.getAttribute('data-entry-id');
            if (clickedChip.classList.contains('empty-chip')) {
                entryId = `empty|${clickedChip.getAttribute('data-date')}|${clickedChip.getAttribute('data-role')}`;
            }
            if (entryId && !selectedShifts.has(String(entryId))) {
                arr.push(String(entryId));
            }
        }
        return arr;
    }
    if (!clickedChip) return [];
    let entryId = clickedChip.getAttribute('data-entry-id');
    if (clickedChip.classList.contains('empty-chip')) {
        entryId = `empty|${clickedChip.getAttribute('data-date')}|${clickedChip.getAttribute('data-role')}`;
    }
    return [String(entryId)];
}

function toBritishDate(isoStr) {
    if(!isoStr) return '';
    const parts = isoStr.split('-');
    if(parts.length !== 3) return isoStr;
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function fromBritishDate(britStr) {
    if(!britStr) return '';
    const parts = britStr.split('/');
    if(parts.length !== 3) return britStr;
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
}

document.addEventListener('DOMContentLoaded', () => {
    const todayStr = new Date().toISOString().split('T')[0];
    document.getElementById('startDate').value = getMonday(todayStr);    
    document.body.classList.add('read-only'); // Default to Read-Only mode
    
    let savedRoster = localStorage.getItem('currentRoster') || 'QA';
    if (localStorage.getItem('hideDailyTasks') !== null) {
        isDailyTasksHidden = localStorage.getItem('hideDailyTasks') === 'true';
    }
    
    switchRoster(savedRoster); // Set initial state
    loadStaff();

    const menu = document.getElementById('contextMenu');
    if (menu && !document.getElementById('cm-shift-set-time')) {
        const setTimeItem = document.createElement('div');
        setTimeItem.className = 'cm-item cm-shift';
        setTimeItem.id = 'cm-shift-set-time';
        setTimeItem.innerText = 'Set Time';
        setTimeItem.onclick = () => {
            if (cmTarget && cmTarget.shiftChip) {
                const entryId = cmTarget.shiftChip.getAttribute('data-entry-id');
                const timeEl = cmTarget.shiftChip.querySelector('.shift-time');
                const currentTime = timeEl ? timeEl.innerText.replace('🕒 ', '').trim() : '';
                editShiftTime(entryId, currentTime);
            }
        };
        menu.appendChild(setTimeItem);
    }

    document.querySelectorAll('button').forEach(btn => {
        if (btn.getAttribute('onclick') === 'clearWeeklyTasks()') {
            btn.innerText = 'Clear Data';
        }
    });
});

function switchRoster(roster) {
    currentRoster = roster;
    localStorage.setItem('currentRoster', roster);
    document.getElementById('qaRosterBtn').classList.toggle('active', roster === 'QA');
    document.getElementById('planningRosterBtn').classList.toggle('active', roster === 'Planning');
    document.title = `Radiotherapy ${roster} Section - Clinical Rota Grid`;
    loadRoster();
}
window.switchRoster = switchRoster;

function toggleTheme() {
    isLightTheme = !isLightTheme;
    document.body.classList.toggle('light-theme', isLightTheme);
    document.getElementById('themeBtn').innerText = isLightTheme ? 'Toggle Dark Theme' : 'Toggle Light Theme';
    loadRoster();
}

async function toggleAdmin() {
    if(isAdmin) {
        isAdmin = false;
        document.body.classList.add('read-only');
        document.getElementById('adminBtn').innerText = 'Admin Login';
        document.getElementById('adminBtn').style.background = '#e53e3e';
        document.getElementById('adminPanel').style.display = 'none';
        
        const defaultTasksBtn = document.getElementById('defaultTasksBtn');
        if (defaultTasksBtn) defaultTasksBtn.remove();
        
        const updateIndexBtn = document.getElementById('updateIndexBtn');
        if (updateIndexBtn) updateIndexBtn.remove();
        
        await customAlert('Logged out. Read-only mode enabled.');
    } else {
        const pwd = await customPrompt('Enter Admin Password:');
        if(pwd === 'admin') {
            isAdmin = true;
            document.body.classList.remove('read-only');
            document.getElementById('adminBtn').innerText = 'Logout Admin';
            document.getElementById('adminBtn').style.background = '#4a5568';
            document.getElementById('adminPanel').style.display = 'flex';
            
            if (!document.getElementById('defaultTasksBtn')) {
                const btn = document.createElement('button');
                btn.id = 'defaultTasksBtn';
                btn.className = 'modal-btn modal-btn-secondary';
                btn.innerText = 'Default Tasks';
                btn.onclick = openDefaultTasksManager;
                document.getElementById('adminPanel').appendChild(btn);
            }
            
            if (!document.getElementById('updateIndexBtn')) {
                const btnUpdate = document.createElement('button');
                btnUpdate.id = 'updateIndexBtn';
                btnUpdate.className = 'modal-btn modal-btn-danger';
                btnUpdate.innerText = 'Update index.html';
                btnUpdate.style.marginTop = '20px';
                btnUpdate.onclick = promptUpdateIndexHtml;
                document.querySelector('.container').appendChild(btnUpdate);
            }
            
            await customAlert('Admin mode enabled.');
        } else if (pwd !== null) {
            await customAlert('Incorrect password.');
        }
    }
    loadRoster();
}

async function promptUpdateIndexHtml() {
    if (!isAdmin) return;
    
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.html';
    fileInput.style.display = 'none';
    
    fileInput.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        const pwd = await customPrompt(`DANGER: Enter Admin Password to confirm updating index.html with "${file.name}":`);
        if (pwd !== 'admin') {
            if (pwd !== null) await customAlert('Incorrect password.');
            return;
        }
        
        if (!await customConfirm(`Are you sure you want to overwrite index.html with "${file.name}"? This could break the app.`)) {
            return;
        }
        
        const formData = new FormData();
        formData.append('indexfile', file);
        
        try {
            const response = await fetch('/api/admin/update-index', {
                method: 'POST',
                body: formData
            });
            const result = await response.json();
            if (result.success) {
                await customAlert('index.html successfully updated! The page will now reload.');
                window.location.reload();
            } else {
                await customAlert(result.error || 'Failed to update index.html.');
            }
        } catch (err) {
            console.error(err);
            await customAlert('Error uploading index.html.');
        }
    };
    
    document.body.appendChild(fileInput);
    fileInput.click();
    document.body.removeChild(fileInput);
}

// --- CUSTOM MODAL ENGINE ---
function showModal(options) {
    return new Promise(resolve => {
        const overlay = document.getElementById('customModal');
        const title = document.getElementById('modalTitle');
        const message = document.getElementById('modalMessage');
        const inputContainer = document.getElementById('modalInputContainer');
        const buttonsContainer = document.getElementById('modalButtons');

        title.textContent = options.title || 'Notification';
        message.textContent = options.message || '';
        inputContainer.innerHTML = '';
        buttonsContainer.innerHTML = '';

        let inputEl = null;
        if (options.type === 'prompt') {
            inputEl = document.createElement('input');
            inputEl.type = 'text';
            inputEl.className = 'modal-input';
            inputEl.value = options.defaultValue || '';
            inputContainer.appendChild(inputEl);
            setTimeout(() => inputEl.focus(), 10);
        }

        let checkboxEl = null;

        const closeAndResolve = (value) => {
            overlay.style.display = 'none';
            if (options.checkbox) {
                resolve({ action: value, checked: checkboxEl.checked });
            } else {
                resolve(value);
            }
        };

        if (options.buttons) {
            options.buttons.forEach(btn => {
                const b = document.createElement('button');
                b.textContent = btn.text;
                b.className = `modal-btn ${btn.class || 'modal-btn-secondary'}`;
                b.onclick = () => closeAndResolve(btn.value);
                buttonsContainer.appendChild(b);
            });
        } else if (options.type === 'alert') {
            const okBtn = document.createElement('button');
            okBtn.textContent = 'OK';
            okBtn.className = 'modal-btn modal-btn-primary';
            okBtn.onclick = () => closeAndResolve(true);
            buttonsContainer.appendChild(okBtn);
        } else if (options.type === 'confirm') {
            const yesBtn = document.createElement('button');
            yesBtn.textContent = 'Yes';
            yesBtn.className = 'modal-btn modal-btn-danger';
            yesBtn.onclick = () => closeAndResolve(true);
            const noBtn = document.createElement('button');
            noBtn.textContent = 'Cancel';
            noBtn.className = 'modal-btn modal-btn-secondary';
            noBtn.onclick = () => closeAndResolve(false);
            buttonsContainer.appendChild(yesBtn);
            buttonsContainer.appendChild(noBtn);
        } else if (options.type === 'multi-prompt') {
            const inputs = [];
            options.inputs.forEach(inp => {
                const label = document.createElement('label');
                label.className = 'modal-label';
                label.textContent = inp.label;
                inputContainer.appendChild(label);
                
                const el = document.createElement('input');
                el.type = inp.inputType || 'text';
                el.className = 'modal-input';
                el.value = inp.defaultValue || '';
                el.dataset.id = inp.id;
                inputContainer.appendChild(el);
                inputs.push(el);
            });
            if(inputs.length > 0) setTimeout(() => inputs[0].focus(), 10);
            
            const okBtn = document.createElement('button');
            okBtn.textContent = 'OK';
            okBtn.className = 'modal-btn modal-btn-primary';
            okBtn.onclick = () => {
                const result = {};
                inputs.forEach(el => result[el.dataset.id] = el.value);
                closeAndResolve(result);
            };
            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = 'Cancel';
            cancelBtn.className = 'modal-btn modal-btn-secondary';
            cancelBtn.onclick = () => closeAndResolve(null);
            buttonsContainer.appendChild(okBtn);
            buttonsContainer.appendChild(cancelBtn);
        } else if (options.type === 'prompt') {
            const okBtn = document.createElement('button');
            okBtn.textContent = 'OK';
            okBtn.className = 'modal-btn modal-btn-primary';
            okBtn.onclick = () => closeAndResolve(inputEl.value);
            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = 'Cancel';
            cancelBtn.className = 'modal-btn modal-btn-secondary';
            cancelBtn.onclick = () => closeAndResolve(null);
            buttonsContainer.appendChild(okBtn);
            buttonsContainer.appendChild(cancelBtn);
            
            inputEl.addEventListener('keypress', (e) => {
                if(e.key === 'Enter') closeAndResolve(inputEl.value);
            });
        }

        if (options.checkbox) {
            const cbLabel = document.createElement('label');
            cbLabel.className = 'modal-label';
            cbLabel.style.display = 'flex';
            cbLabel.style.alignItems = 'center';
            cbLabel.style.marginTop = '15px';
            cbLabel.innerHTML = `<input type="checkbox" id="modalCheckbox" style="margin-right:8px; width:16px; height:16px;" ${options.checkbox.checked ? 'checked' : ''}> <strong>${options.checkbox.label}</strong>`;
            inputContainer.appendChild(cbLabel);
            checkboxEl = cbLabel.querySelector('input');
        }

        overlay.style.display = 'flex';
    });
}

async function customAlert(msg) { return showModal({ type: 'alert', message: msg }); }
async function customConfirm(msg) { return showModal({ title: 'Confirm Action', type: 'confirm', message: msg }); }
async function customPrompt(msg, def) { return showModal({ title: 'Input Required', type: 'prompt', message: msg, defaultValue: def }); }

async function loadStaff() {
    const res = await fetch('/api/staff');
    allAvailableStaff = await res.json();
    
    const renderSubmenu = (id, clickHandlerName) => {
        const submenu = document.getElementById(id);
        if (submenu) {
            submenu.innerHTML = allAvailableStaff.map(s => {
                const safeName = s.name.replace(/'/g, "\\'").replace(/"/g, "&quot;");
                return `<div class="cm-item" onclick="${clickHandlerName}('${safeName}')">${s.name}</div>`;
            }).join('');
        }
    };

    renderSubmenu('cm-assign-submenu', 'handleCmAssign');
    renderSubmenu('cm-swap-submenu', 'handleCmSwap');
    renderSubmenu('cm-dropzone-submenu', 'handleCmAdd');
}

function openStaffManager() {
    if (!isAdmin) return;
    renderStaffManager();
    document.getElementById('staffModal').style.display = 'flex';
}

function renderStaffManager() {
    const container = document.getElementById('staffListContainer');
    container.innerHTML = allAvailableStaff.map(s => `
        <div class="staff-list-row">
            <span class="staff-list-name">${s.name}</span>
            <div>
                <button class="modal-btn modal-btn-secondary" style="padding: 4px 8px; font-size: 12px;" onclick="editStaffMember(${s.id}, '${s.name.replace(/'/g, "\\'")}')">Edit</button>
                <button class="modal-btn modal-btn-danger" style="padding: 4px 8px; font-size: 12px; margin-left: 5px;" onclick="deleteStaffMember(${s.id})">Delete</button>
            </div>
        </div>
    `).join('');
}

async function addStaffMember() {
    const result = await showModal({
        title: 'Add Staff Member',
        type: 'multi-prompt',
        inputs: [
            { id: 'surname', label: 'Surname:', defaultValue: '' },
            { id: 'firstname', label: 'First Name:', defaultValue: '' }
        ]
    });
    if (result && result.surname && result.firstname) {
        const fullName = `${result.surname.trim()}, ${result.firstname.trim()}`;
        const res = await fetch('/api/staff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: fullName }) });
        if (res.ok) { await loadStaff(); renderStaffManager(); } 
        else { const err = await res.json(); await customAlert(err.error || 'Failed to add staff.'); }
    }
}

async function editStaffMember(id, currentName) {
    const newName = await customPrompt('Edit Staff Name (Surname, Firstname):', currentName);
    if (newName && newName.trim() !== '' && newName !== currentName) {
        const res = await fetch(`/api/staff/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newName.trim() }) });
        if (res.ok) { await loadStaff(); renderStaffManager(); loadRoster(); } 
        else { const err = await res.json(); await customAlert(err.error || 'Failed to update staff.'); }
    }
}

async function deleteStaffMember(id) {
    if (await customConfirm('Are you sure? This will delete the staff member and ALL their assigned shifts and tasks.')) {
        const res = await fetch(`/api/staff/${id}`, { method: 'DELETE' });
        if (res.ok) { await loadStaff(); renderStaffManager(); loadRoster(); } 
        else { await customAlert('Failed to delete staff.'); }
    }
}

async function openDefaultTasksManager() {
    if (!isAdmin) return;
    
    const staffRes = await fetch('/api/staff');
    const staff = await staffRes.json();
    
    const tasksRes = await fetch('/api/tasks/unique');
    const uniqueTasks = await tasksRes.json();
    
    const overlay = document.getElementById('customModal');
    const title = document.getElementById('modalTitle');
    const message = document.getElementById('modalMessage');
    const inputContainer = document.getElementById('modalInputContainer');
    const buttonsContainer = document.getElementById('modalButtons');

    title.textContent = 'Configure Default Tasks';
    message.textContent = 'Assign a default task to each staff member. This will automatically allocate them when importing a roster.';
    inputContainer.innerHTML = '';
    buttonsContainer.innerHTML = '';

    const table = document.createElement('table');
    table.style.width = '100%';
    table.style.marginTop = '10px';
    table.innerHTML = `<tr><th style="text-align:left; padding-bottom:5px;">Staff Name</th><th style="text-align:left; padding-bottom:5px;">Default Task</th></tr>`;
    
    const selects = [];
    
    staff.forEach(s => {
        const tr = document.createElement('tr');
        const tdName = document.createElement('td');
        tdName.textContent = s.name;
        
        const tdTask = document.createElement('td');
        const select = document.createElement('select');
        select.className = 'modal-input';
        select.style.marginBottom = '5px';
        select.style.width = '100%';
        select.dataset.staffId = s.id;
        
        const optNone = document.createElement('option');
        optNone.value = '';
        optNone.textContent = '-- None --';
        select.appendChild(optNone);
        
        uniqueTasks.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.task_name;
            opt.textContent = t.task_name;
            if (s.default_task === t.task_name) opt.selected = true;
            select.appendChild(opt);
        });
        
        selects.push(select);
        tdTask.appendChild(select);
        tr.appendChild(tdName);
        tr.appendChild(tdTask);
        table.appendChild(tr);
    });
    
    const scrollContainer = document.createElement('div');
    scrollContainer.style.maxHeight = '400px';
    scrollContainer.style.overflowY = 'auto';
    scrollContainer.appendChild(table);
    inputContainer.appendChild(scrollContainer);
    
    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save Defaults';
    saveBtn.className = 'modal-btn modal-btn-primary';
    saveBtn.onclick = async () => {
        const updates = selects.map(sel => ({
            id: sel.dataset.staffId,
            default_task: sel.value
        }));
        
        const res = await fetch('/api/staff/defaults', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ updates })
        });
        
        if (res.ok) {
            overlay.style.display = 'none';
            await loadStaff();
            await customAlert('Default tasks updated successfully.');
        } else {
            await customAlert('Failed to update defaults.');
        }
    };
    
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.className = 'modal-btn modal-btn-secondary';
    cancelBtn.onclick = () => { overlay.style.display = 'none'; };
    
    buttonsContainer.appendChild(saveBtn);
    buttonsContainer.appendChild(cancelBtn);
    
    overlay.style.display = 'flex';
}

async function openStatistics() {
    if (!isAdmin) return;
    try {
        const res = await fetch('/api/statistics');
        const stats = await res.json();
        
        if (!stats.success) {
            await customAlert('Failed to load statistics.');
            return;
        }

        let msg = `📊 ROSTER STATISTICS\n\n`;
        
        msg += `--- Staff Statuses ---\n`;
        if (stats.statuses.length === 0) msg += `None recorded.\n`;
        stats.statuses.forEach(s => msg += `• ${s.status}: ${s.count} days\n`);
        msg += `\n`;
        
        msg += `--- Task Allocation (Top 10) ---\n`;
        if (stats.taskAllocation.length === 0) msg += `No tasks assigned.\n`;
        stats.taskAllocation.forEach(t => msg += `• ${t.name}: ${t.count} tasks\n`);
        msg += `\n`;

        msg += `--- Tasks Over Time (Last 6 Months) ---\n`;
        if (stats.tasksOverTime.length === 0) msg += `No tasks recorded.\n`;
        stats.tasksOverTime.forEach(t => {
            const monthLabel = t.month ? t.month : 'Unknown';
            msg += `• ${monthLabel}: ${t.count} tasks\n`;
        });
        msg += `\n`;

        msg += `--- Missing Assignments ---\n`;
        msg += `• Manually Added Missing: ${stats.manualMissing}\n`;
        msg += `• Ignored Missing Slots: ${stats.totalIgnored}\n\n`;

        msg += `--- Shift Distribution (Top 10) ---\n`;
        if (stats.roleCounts.length === 0) msg += `No shifts recorded.\n`;
        stats.roleCounts.forEach(r => msg += `• ${r.shift_title}: ${r.count} shifts\n`);

        await customAlert(msg);
    } catch (err) {
        console.error(err);
        await customAlert('Error loading statistics.');
    }
}

function exportDatabase() {
    if (!isAdmin) return;
    window.location.href = `/api/database/export?rosterType=${currentRoster}`;
}

async function exportTasksDatabase() {
    if (!isAdmin) return;
    
    const choice = await showModal({
        title: 'Export Tasks',
        message: 'Do you want to export all tasks in the database, or just the tasks for the currently viewed week?',
        buttons: [
            { text: 'Export All Tasks', value: 'all', class: 'modal-btn-primary' },
            { text: 'Export Current Week', value: 'week', class: 'modal-btn-primary' },
            { text: 'Cancel', value: null, class: 'modal-btn-secondary' }
        ]
    });
    
    if (!choice) return;
    
    if (choice === 'all') {
        window.location.href = `/api/database/export/tasks?rosterType=${currentRoster}`;
    } else {
        const start = document.getElementById('startDate').value;
        const d = new Date(start + 'T12:00:00Z');
        d.setUTCDate(d.getUTCDate() + 6);
        const end = d.toISOString().split('T')[0];
        window.location.href = `/api/database/export/tasks?startDate=${start}&endDate=${end}&rosterType=${currentRoster}`;
    }
}

function importTasksDatabase() {
    if (!isAdmin) return;
    document.getElementById('taskDbFileInput').click();
}

async function handleImportTasksDatabase(event) {
    if (!isAdmin) return;
    const file = event.target.files[0];
    if (!file) return;

    const choice = await showModal({
        title: 'Import Tasks',
        message: 'Do you want to import these tasks as a weekly template starting from the currently viewed week, or import all tasks exactly as they are dated in the file?',
        buttons: [
            { text: 'Import as Weekly Template', value: 'template', class: 'modal-btn-primary' },
            { text: 'Import All Tasks', value: 'all', class: 'modal-btn-danger' },
            { text: 'Cancel', value: null, class: 'modal-btn-secondary' }
        ]
    });

    if (!choice) {
        event.target.value = '';
        return;
    }

    let weeks = 1;
    let conflict = 'append';

    if (choice === 'template') {
        const weeksResult = await showModal({
            title: 'Template Options',
            type: 'multi-prompt',
            inputs: [
                { id: 'weeks', label: 'How many weeks should this template be replicated for?', defaultValue: '1', inputType: 'number' }
            ]
        });
        if (!weeksResult || !weeksResult.weeks) {
            event.target.value = '';
            return;
        }
        weeks = parseInt(weeksResult.weeks) || 1;

        const conflictResult = await showModal({
            title: 'Existing Tasks',
            message: 'Should the imported tasks overwrite any existing tasks in the target weeks, or append to them?',
            buttons: [
                { text: 'Overwrite Existing', value: 'overwrite', class: 'modal-btn-danger' },
                { text: 'Append to Existing', value: 'append', class: 'modal-btn-primary' },
                { text: 'Cancel', value: null, class: 'modal-btn-secondary' }
            ]
        });
        if (!conflictResult) {
            event.target.value = '';
            return;
        }
        conflict = conflictResult;
    }

    const formData = new FormData();
    formData.append('database', file);

    let url = `/api/database/import/tasks?mode=${choice}&rosterType=${currentRoster}`;
    if (choice === 'template') {
        const start = document.getElementById('startDate').value;
        url += `&targetDate=${start}&weeks=${weeks}&conflict=${conflict}`;
    }

    try {
        const response = await fetch(url, { method: 'POST', body: formData });
        const result = await response.json();
        if (result.success) {
            await customAlert('Tasks imported successfully.');
            loadRoster();
        } else {
            await customAlert(result.error || 'Failed to import tasks.');
        }
    } catch (e) {
        await customAlert('Error importing tasks.');
    } finally {
        event.target.value = '';
    }
}

function importDatabase() {
    if (!isAdmin) return;
    document.getElementById('dbFileInput').click();
}

async function handleImportDatabase(event) {
    if (!isAdmin) return;
    const file = event.target.files[0];
    if (!file) return;

    if (!await customConfirm(`Are you sure you want to restore the database from this file? This will overwrite all current data for the ${currentRoster} roster.`)) {
        event.target.value = '';
        return;
    }

    const formData = new FormData();
    formData.append('database', file);

    try {
        const response = await fetch(`/api/database/import?rosterType=${currentRoster}`, { method: 'POST', body: formData });
        const result = await response.json();
        if (result.success) {
            await customAlert('Database restored successfully.');
            loadStaff();
            loadRoster();
        } else {
            await customAlert(result.error || 'Failed to restore database.');
        }
    } catch (e) {
        await customAlert('Error restoring database.');
    } finally {
        event.target.value = '';
    }
}

async function uploadFile(overrideMode = null) {
    const fileInput = document.getElementById('csvFile');
    if (!fileInput.files[0]) {
        await customAlert('Please choose a valid Optima Excel file (.xlsx) first.');
        return;
    }

    const formData = new FormData();
    formData.append('roster', fileInput.files[0]);
    formData.append('rosterType', currentRoster);
    if (overrideMode) formData.append('mode', overrideMode);

    const response = await fetch('/api/upload', { method: 'POST', body: formData });
    const result = await response.json();
    
    if (result.requiresConfirmation) {
        const choice = await showModal({
            title: 'Sync Conflict',
            message: 'Data already exists for this time period.\nHow would you like to proceed?',
            buttons: [
                { text: 'Append (Add Only)', value: 'append', class: 'modal-btn-primary' },
                { text: 'Merge (Mirror File)', value: 'merge', class: 'modal-btn-primary' },
                { text: 'Overwrite (Wipe All)', value: 'overwrite', class: 'modal-btn-danger' },
                { text: 'Cancel', value: null, class: 'modal-btn-secondary' }
            ],
            checkbox: { label: 'Preview Changes Before Applying', checked: true }
        });
        if (choice && choice.action) {
            let mode = choice.action;
            if (choice.checked && mode !== 'overwrite') {
                mode = 'preview_' + mode;
            }
            return uploadFile(mode);
        }
        return;
    }

    if (result.isPreview) {
        previewState.active = true;
        previewState.mode = overrideMode ? overrideMode.replace('preview_', '') : 'merge';
        previewState.added = (result.previewData.added || []).map((a, i) => ({
            date: a.date,
            staff_name: a.staff,
            shift_title: a.role,
            status: a.status || 'Normal',
            shift_time: a.shift_time || '',
            tasks: a.tasks || [],
            previewStatus: 'pending',
            previewId: i,
            isPreviewAdd: true
        }));
        previewState.deleted = (result.previewData.deleted || []).map((d, i) => ({
            ...d,
            previewStatus: 'pending',
            previewId: i,
            isPreviewDelete: true
        }));
        renderPreviewControls();
        loadRoster();
        return;
    }

    if (result.success) {
        let summaryMsg = result.message || 'Sync successful.';

        if (result.summary) {
            const { deleted, added, recoveredTasks } = result.summary;
            if (deleted.length > 0 || added.length > 0 || (recoveredTasks && recoveredTasks.length > 0)) summaryMsg += '\n\n';
            
            if (recoveredTasks && recoveredTasks.length > 0) {
                summaryMsg += `⚠️ PRIORITY: ORPHANED TASKS RECOVERED ⚠️\n`;
                summaryMsg += `The following tasks were attached to deleted shifts. They have been preserved on the Missing Assignment for their respective roles:\n`;
                recoveredTasks.forEach(t => {
                    summaryMsg += `• ${t.date} | ${t.task} (Recovered to ${t.role} from ${t.originalStaff})\n`;
                });
                summaryMsg += '\n';
            }

            if (deleted.length > 0) {
                summaryMsg += `--- Removed Shifts (${deleted.length}) ---\n`;
                deleted.forEach(d => {
                    let taskStr = d.tasks && d.tasks.length > 0 ? ` [Tasks: ${d.tasks.join(', ')}]` : '';
                    summaryMsg += `• ${d.date} | ${d.staff} (${d.role})${taskStr}\n`;
                });
                summaryMsg += '\n';
            }
            if (added.length > 0) {
                summaryMsg += `--- Added Shifts (${added.length}) ---\n`;
                added.forEach(a => {
                    summaryMsg += `• ${a.date} | ${a.staff} (${a.role})\n`;
                });
            }
        }
        
        await customAlert(summaryMsg.trim());
        loadStaff();
        loadRoster();
    } else {
        await customAlert('Sync Run Failed: ' + (result.error || 'Unknown error'));
    }
}

async function autoGroupTasks() {
    if (!isAdmin) return;
    if (!await customConfirm('Are you sure you want to reorder all staff within their roles to group similar tasks together?')) return;
    
    const start = document.getElementById('startDate').value;
    const d = new Date(start + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + 6);
    const end = d.toISOString().split('T')[0];
    
    try {
        const response = await fetch('/api/roster/auto-group-tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ startDate: start, endDate: end, rosterType: currentRoster })
        });
        if (response.ok) loadRoster();
        else await customAlert('Failed to auto-group tasks.');
    } catch (err) {
        console.error(err);
    }
}

async function clearWeeklyTasks() {
    if (!isAdmin) return;
    
    const start = document.getElementById('startDate').value;
    const d = new Date(start + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + 6);
    const end = d.toISOString().split('T')[0];
    
    const overlay = document.getElementById('customModal');
    const title = document.getElementById('modalTitle');
    const message = document.getElementById('modalMessage');
    const inputContainer = document.getElementById('modalInputContainer');
    const buttonsContainer = document.getElementById('modalButtons');

    title.textContent = 'Clear Data';
    message.textContent = `Select what data you want to clear from the ${currentRoster} roster.`;
    inputContainer.innerHTML = '';
    buttonsContainer.innerHTML = '';

    const labelType = document.createElement('label');
    labelType.className = 'modal-label';
    labelType.style.display = 'block';
    labelType.style.marginBottom = '5px';
    labelType.textContent = 'Data to clear:';
    inputContainer.appendChild(labelType);

    const typeSelect = document.createElement('select');
    typeSelect.className = 'modal-input';
    typeSelect.style.marginBottom = '15px';
    typeSelect.innerHTML = `
        <option value="tasks">Tasks Only</option>
        <option value="shifts">Shifts Only</option>
        <option value="both">Both (Tasks & Shifts)</option>
    `;
    inputContainer.appendChild(typeSelect);

    const labelScope = document.createElement('label');
    labelScope.className = 'modal-label';
    labelScope.style.display = 'block';
    labelScope.style.marginBottom = '5px';
    labelScope.textContent = 'Time Scope:';
    inputContainer.appendChild(labelScope);

    const scopeSelect = document.createElement('select');
    scopeSelect.className = 'modal-input';
    scopeSelect.style.marginBottom = '15px';
    scopeSelect.innerHTML = `
        <option value="week">Current Week Only (${start})</option>
        <option value="all">All Dates</option>
    `;
    inputContainer.appendChild(scopeSelect);

    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'Clear Data';
    clearBtn.className = 'modal-btn modal-btn-danger';
    clearBtn.onclick = async () => {
        if (!await customConfirm('Are you absolutely sure you want to delete this data? This cannot be undone.')) return;
        
        const type = typeSelect.value;
        const scope = scopeSelect.value;
        
        try {
            const response = await fetch(`/api/data/clear?startDate=${start}&endDate=${end}&rosterType=${currentRoster}&type=${type}&scope=${scope}`, {
                method: 'DELETE'
            });
            if (response.ok) {
                overlay.style.display = 'none';
                loadRoster();
            } else {
                await customAlert('Failed to clear data.');
            }
        } catch (err) {
            console.error(err);
        }
    };
    
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.className = 'modal-btn modal-btn-secondary';
    cancelBtn.onclick = () => { overlay.style.display = 'none'; };
    
    buttonsContainer.appendChild(clearBtn);
    buttonsContainer.appendChild(cancelBtn);
    
    overlay.style.display = 'flex';
}

function setDatesCurrent4Weeks() {
    const todayStr = new Date().toISOString().split('T')[0];
    document.getElementById('startDate').value = getMonday(todayStr);
    loadRoster();
}

function setDatesPrevious4Weeks() {
    const rawStart = document.getElementById('startDate').value;
    const d = new Date(rawStart + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - 7);
    document.getElementById('startDate').value = d.toISOString().split('T')[0];
    loadRoster();
}

function setDatesNext4Weeks() {
    const rawStart = document.getElementById('startDate').value;
    const d = new Date(rawStart + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + 7);
    document.getElementById('startDate').value = d.toISOString().split('T')[0];
    loadRoster();
}

async function loadRoster() {
    const rawStart = document.getElementById('startDate').value || new Date().toISOString().split('T')[0];
    const start = getMonday(rawStart);
    document.getElementById('startDate').value = start;
    
    const d = new Date(start + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + 6);
    const end = d.toISOString().split('T')[0];
    
    const response = await fetch(`/api/roster?startDate=${start}&endDate=${end}&rosterType=${currentRoster}`);
    const data = await response.json();
    
    const tasksResponse = await fetch(`/api/tasks?startDate=${start}&endDate=${end}&rosterType=${currentRoster}`);
    const tasksData = await tasksResponse.json();
    
    const metaResponse = await fetch(`/api/metadata?startDate=${start}&endDate=${end}&rosterType=${currentRoster}`);
    const metaData = await metaResponse.json();
    
    renderGridDashboard(data, tasksData, metaData);
}

// Global Helper to get Week Commencing Monday Date for any given calendar date string
function getMonday(dateStr) {
    const d = new Date(dateStr + 'T12:00:00Z');
    const day = d.getUTCDay();
    const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1); 
    d.setUTCDate(diff);
    return d.toISOString().split('T')[0];
}

// Generate an explicit list of sequential dates from Mon-Sun based on a Monday start date
function getWeekDaysArray(mondayStr) {
    const arr = [];
    for(let i=0; i<7; i++) {
        const d = new Date(mondayStr + 'T12:00:00Z');
        d.setUTCDate(d.getUTCDate() + i);
        arr.push(d.toISOString().split('T')[0]);
    }
    return arr;
}

// Generates a unique, consistent background color dynamically based on any string (e.g. unknown new Roles)
function getRoleColor(roleName) {
    let hash = 0;
    for (let i = 0; i < roleName.length; i++) {
        hash = roleName.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash % 360);
    if (isLightTheme) {
        return `background: hsl(${hue}, 70%, 90%) !important; border-color: hsl(${hue}, 70%, 80%); border-left: 4px solid hsl(${hue}, 70%, 60%);`;
    }
    return `background: hsl(${hue}, 40%, 25%) !important; border-color: hsl(${hue}, 40%, 35%); border-left: 4px solid hsl(${hue}, 60%, 50%);`;
}

window.toggleDailyTasks = function() {
    isDailyTasksHidden = !isDailyTasksHidden;
    localStorage.setItem('hideDailyTasks', isDailyTasksHidden);
    
    document.querySelectorAll('.dt-header').forEach(el => {
        if (isDailyTasksHidden) {
            el.classList.add('collapsed');
            el.querySelector('.dt-toggle-icon').innerText = '▶';
        } else {
            el.classList.remove('collapsed');
            el.querySelector('.dt-toggle-icon').innerText = '▼';
        }
    });
    
    document.querySelectorAll('.tasks-cell').forEach(el => {
        el.classList.toggle('collapsed', isDailyTasksHidden);
    });
};

function renderGridDashboard(data, tasksData = [], metaData = []) {
    const container = document.getElementById('rotaDashboard');
    container.innerHTML = '';

    let renderData = [...(data || [])];
    
    if (previewState.active) {
        renderData = renderData.map(item => {
            const delMatch = previewState.deleted.find(d => 
                d.previewStatus === 'pending' &&
                ((d.entry_id && d.entry_id === item.entry_id) || 
                 (d.date === item.date && d.staff === item.staff_name && d.role === item.shift_title))
            );
            if (delMatch) {
                return { ...item, isPreviewDelete: true, previewStatus: delMatch.previewStatus, previewId: delMatch.previewId };
            }
            return item;
        });

        previewState.added.forEach((addItem) => {
            if (addItem.previewStatus === 'pending') {
                renderData.push({
                    ...addItem,
                    entry_id: 'preview_add_' + addItem.previewId
                });
            }
        });
    }

    // Structure: weeks[weekCommencingDate][shiftTitle][targetDate] = []
    const weeks = {};
    
    // Force pre-populate exactly 1 week based on the date filter so the view never collapses
    const uiStart = document.getElementById('startDate').value;
    if (uiStart) {
        for (let i = 0; i < 1; i++) {
            let tempD = new Date(uiStart + 'T12:00:00Z');
            tempD.setUTCDate(tempD.getUTCDate() + (i * 7));
            weeks[tempD.toISOString().split('T')[0]] = {};
        }
    }

    // Dynamically compile a list of all unique Roles present in the dataset 
    // to give users a clean dropdown option matrix list
    const uniqueRolesSet = new Set();
    const uniqueStaffSet = new Set();
    const staffDailyRoles = {};

    (renderData || []).forEach(entry => {
        const wkCommence = getMonday(entry.date);
        
        // ENFORCE STRICT 1-WEEK DISPLAY
        if (!weeks[wkCommence]) return;
        
        const roleRow = entry.shift_title || "General QA";
        const dateKey = entry.date;

        uniqueRolesSet.add(roleRow);
        uniqueStaffSet.add(entry.staff_name);

        if (!staffDailyRoles[dateKey]) staffDailyRoles[dateKey] = {};
        if (!staffDailyRoles[dateKey][entry.staff_name]) staffDailyRoles[dateKey][entry.staff_name] = 0;
        staffDailyRoles[dateKey][entry.staff_name]++;

        if (!weeks[wkCommence]) weeks[wkCommence] = {};
        if (!weeks[wkCommence][roleRow]) weeks[wkCommence][roleRow] = {};
        if (!weeks[wkCommence][roleRow][dateKey]) weeks[wkCommence][roleRow][dateKey] = [];

        weeks[wkCommence][roleRow][dateKey].push(entry);
    });

    // Fallback boilerplate options if the dataset is sparse
    if (uniqueRolesSet.size === 0) {
        uniqueRolesSet.add("Elec").add("QA L").add("IMRT").add("QA");
    }
    
    const dynamicRolesList = Array.from(uniqueRolesSet).sort();
    const allStaff = Array.from(uniqueStaffSet).sort();

    // Ensure every week block has an entry for every known role so the structural grid renders completely
    Object.keys(weeks).forEach(wk => {
        dynamicRolesList.forEach(role => {
            if (!weeks[wk][role]) weeks[wk][role] = {};
        });
    });

    const sortedWeeks = Object.keys(weeks).sort();
    const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    const todayStr = new Date().toISOString().split('T')[0];

    sortedWeeks.forEach(wk => {
        const weekBlock = document.createElement('div');
        weekBlock.className = 'week-block';
        
        const displayDate = new Date(wk).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
        weekBlock.innerHTML = `<div class="week-header">Week Commencing: ${displayDate}</div>`;

        const grid = document.createElement('div');
        grid.className = 'rota-grid';

        grid.innerHTML += `<div class="grid-header" style="background:#1a202c; border-bottom:2px solid #4a5568;">e-roster Role</div>`;
        const weekDates = getWeekDaysArray(wk);
        
        weekDates.forEach((dStr, idx) => {
            const isToday = (dStr === todayStr);
            const todayClass = isToday ? ' today-header' : '';
            const calDay = new Date(dStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
            grid.innerHTML += `<div class="grid-header${todayClass}">${dayLabels[idx]}<br><span style="font-size:11px; font-weight:normal; color:${isToday ? '#fff' : '#cbd5e0'};">${calDay}</span></div>`;
        });

        // --- Render Daily Tasks Row (Moved to top) ---
        const dtHeaderClass = isDailyTasksHidden ? 'grid-cell role-title-cell dt-header collapsed' : 'grid-cell role-title-cell dt-header';
        grid.innerHTML += `<div class="${dtHeaderClass}" style="color: #ecc94b; border-left-color: #ecc94b; cursor: pointer; display: flex; justify-content: space-between; align-items: center;" onclick="toggleDailyTasks()">
            <span>Daily Tasks</span>
            <span class="dt-toggle-icon">${isDailyTasksHidden ? '▶' : '▼'}</span>
        </div>`;
        
        weekDates.forEach(dayDate => {
            const dailyTasks = tasksData.filter(t => t.date === dayDate && !t.shift_title);
            const todayCellClass = (dayDate === todayStr) ? ' today-cell' : '';
            const dtCellClass = isDailyTasksHidden ? ' collapsed' : '';
            let cellHTML = `<div class="grid-cell tasks-cell${todayCellClass}${dtCellClass}" data-date="${dayDate}">`;
            cellHTML += `<div style="text-align: right; margin-bottom: 5px;"><button class="add-task-btn" onclick="addTask('${dayDate}')" style="padding: 3px 8px; font-size: 11px; background: #ecc94b; color: #1a202c;">➕ Add Task</button></div>`;
            
            dailyTasks.forEach(task => {
                let assignedCount = 0;
                renderData.forEach(entry => {
                    if (entry.date === dayDate && entry.status !== 'Sick' && entry.status !== 'Unavailable' && !entry.isPreviewDelete) {
                        const hasTask = (entry.assigned_tasks && entry.assigned_tasks.some(at => at.task_name === task.task_name)) ||
                                        (entry.tasks && entry.tasks.includes(task.task_name));
                        if (hasTask) {
                            assignedCount++;
                        }
                    }
                });

                let durationSuffix = '';
                if (task.duration === 'AM') durationSuffix = '<span class="duration-badge">AM</span>';
                else if (task.duration === 'PM') durationSuffix = '<span class="duration-badge">PM</span>';
                cellHTML += `
                    <div class="task-chip ${task.color || 'color-1'}" draggable="true" ondragstart="dragTaskStart(event, ${task.id}, this.getAttribute('data-task-name'), this.getAttribute('data-task-duration'), this.getAttribute('data-task-color'), this.getAttribute('data-task-group-id'))" data-task-id="${task.id}" data-task-type="daily" data-task-name="${task.task_name.replace(/"/g, '&quot;')}" data-task-duration="${task.duration || 'All Day'}" data-task-color="${task.color || 'color-1'}" data-task-group-id="${task.group_id || ''}">
                        <div class="task-header">
                            <span style="font-weight: bold;">${task.task_name}${durationSuffix} (${assignedCount})</span>
                            <button class="delete-btn" onclick="deleteTask(${task.id}, event, '${task.group_id || ''}')" title="Remove Task">✖</button>
                        </div>
                    </div>
                `;
            });
            
            cellHTML += `</div>`;
            grid.innerHTML += cellHTML;
        });

        // Sort explicitly: Lead -> QA -> Elec -> Alphabetical -> QA L
        const roleRows = Object.keys(weeks[wk]).sort((a, b) => {
            const getScore = (role) => {
                const r = role.toLowerCase();
                if (r.includes('mng')) return -1;
                if (r.includes('mpe')) return 0;
                if (r.includes('lead')) return 1;
                if (r.includes('assoc')) return 99;
                if (r.includes('qa l')) return 100;
                if (r.startsWith('qa') || r.startsWith('q.a.')) return 2;
                if (r.includes('elec')) return 3;
                return 50;
            };

            const scoreA = getScore(a);
            const scoreB = getScore(b);

            if (scoreA !== scoreB) {
                return scoreA - scoreB;
            }
            return a.localeCompare(b);
        });

        roleRows.forEach(role => {
            grid.innerHTML += `<div class="grid-cell role-title-cell">${role}</div>`;

            weekDates.forEach(dayDate => {
                const allocations = weeks[wk][role][dayDate] || [];
                const todayCellClass = (dayDate === todayStr) ? ' today-cell' : '';
                let cellHTML = `<div class="grid-cell dropzone${todayCellClass}" data-role="${role}" data-date="${dayDate}" ondragover="allowDrop(event)" ondragleave="dragLeave(event)" ondrop="drop(event)">`;

                const meta = metaData.find(m => m.date === dayDate && m.shift_title === role) || {};
                const isWeekend = (new Date(dayDate + 'T12:00:00Z').getUTCDay() % 6 === 0);
                const isOverflowRole = /\d+$/.test(role) && parseInt(role.match(/\d+$/)[0], 10) > 1;
                
                const shouldShowAutoEmpty = (allocations.length === 0 && !isWeekend && !isOverflowRole);
                const manualAddCount = meta.manual_add || 0;

                let emptyChipsCount = (shouldShowAutoEmpty ? 1 : 0) + manualAddCount;
                if (emptyChipsCount < 0) emptyChipsCount = 0; // Prevent negative chips
                if (!isAdmin) emptyChipsCount = 0; // Hide missing assignments from non-admins
                
                let renderedOrphanedTasks = false;

                for (let i = 0; i < emptyChipsCount; i++) {
                        const commentHtml = meta.comment ? `<div class="empty-comment">📝 ${meta.comment}</div>` : '';
                        const stateClass = meta.is_ignored ? 'ignored' : 'missing';
                        
                        let orphanedTasksHTML = '';
                        if (!renderedOrphanedTasks) {
                            const orphanedTasks = tasksData.filter(t => t.date === dayDate && t.shift_title === role);
                            if (orphanedTasks.length > 0) {
                            orphanedTasksHTML = `<div class="assigned-tasks-container">` + 
                                orphanedTasks.map(t => {
                                    let durationSuffix = '';
                                    if (t.duration === 'AM') durationSuffix = '<span class="duration-badge">AM</span>';
                                    else if (t.duration === 'PM') durationSuffix = '<span class="duration-badge">PM</span>';
                                    return `
                                    <div class="assigned-task-tag ${t.color || 'color-1'}" draggable="true" ondragstart="dragTaskStart(event, ${t.id}, this.getAttribute('data-task-name'), this.getAttribute('data-task-duration'), this.getAttribute('data-task-color'), this.getAttribute('data-task-group-id'))" data-task-id="${t.id}" data-task-type="daily" data-task-duration="${t.duration || 'All Day'}" data-task-color="${t.color || 'color-1'}" data-task-name="${t.task_name.replace(/"/g, '&quot;')}" data-task-group-id="${t.group_id || ''}">
                                        ${t.task_name}${durationSuffix}
                                        <button class="delete-task-tag-btn" onclick="deleteTask(${t.id}, event, '${t.group_id || ''}')" title="Remove Task">✖</button>
                                    </div>
                                    `;
                                }).join('') + `</div>`;
                            }
                            renderedOrphanedTasks = true;
                        }

                        let emptyChipId = `empty|${dayDate}|${role}`;
                        let isSelectedEmpty = selectedShifts.has(emptyChipId) ? ' selected-shift' : '';

                        cellHTML += `<div class="empty-chip ${stateClass}${isSelectedEmpty}" data-date="${dayDate}" data-role="${role}" style="position: relative;">
                            ${isAdmin ? `<button class="delete-btn" style="position: absolute; top: 2px; right: 4px;" onclick="removeMissingAssignment(event, '${dayDate}', '${role.replace(/'/g, "\\'")}')" title="Remove Missing Assignment">✖</button>` : ''}
                            <div style="font-weight: bold;">Missing Assignment</div>
                            ${commentHtml}
                            ${orphanedTasksHTML}
                        </div>`;
                }
                
                if (allocations.length > 0) {
                    allocations.forEach(alloc => {
                        let chipClass = 'allocation-chip';
                        let chipStyle = '';

                        if (alloc.assigned_tasks && alloc.assigned_tasks.length > 0) {
                            const taskColor = alloc.assigned_tasks[0].color || 'color-1';
                            chipClass += ` ${taskColor}`;
                        } else {
                            if (role.includes('Elec')) chipClass += ' chip-elec';
                            else if (role.includes('IMRT')) chipClass += ' chip-imrt';
                            else if (role.toLowerCase().includes('lead')) chipClass += ' chip-lead';
                            else if (role.includes('QA L')) chipClass += ' chip-qa-l';
                            else if (role.startsWith('QA') || role.startsWith('Q.A.')) chipClass += ' chip-qa';
                            else chipStyle = getRoleColor(role);
                        }

                        let previewClasses = '';
                        let previewControls = '';
                        if (previewState.active) {
                            if (alloc.isPreviewAdd) {
                                previewClasses = ' preview-add';
                                previewControls = `
                                    <div class="preview-actions">
                                        <button class="preview-btn accept" onclick="acceptPreview(event, 'add', ${alloc.previewId})" title="Accept">✔️</button>
                                        <button class="preview-btn deny" onclick="denyPreview(event, 'add', ${alloc.previewId})" title="Reject">❌</button>
                                    </div>`;
                            } else if (alloc.isPreviewDelete) {
                                if (alloc.previewStatus === 'pending') {
                                    previewClasses = ' preview-delete';
                                    previewControls = `
                                        <div class="preview-actions">
                                            <button class="preview-btn accept" onclick="acceptPreview(event, 'delete', ${alloc.previewId})" title="Accept Deletion">✔️</button>
                                            <button class="preview-btn deny" onclick="denyPreview(event, 'delete', ${alloc.previewId})" title="Reject Deletion">❌</button>
                                        </div>`;
                                }
                            }
                        }

                    let assignedTasksHTML = '';
                    if (alloc.assigned_tasks && alloc.assigned_tasks.length > 0) {
                        assignedTasksHTML = `<div class="assigned-tasks-container">` + 
                            alloc.assigned_tasks.map(t => {
                                let durationSuffix = '';
                                if (t.duration === 'AM') durationSuffix = '<span class="duration-badge">AM</span>';
                                else if (t.duration === 'PM') durationSuffix = '<span class="duration-badge">PM</span>';
                                return `
                                <div class="assigned-task-tag ${t.color || 'color-1'}" draggable="true" ondragstart="dragAssignedTaskStart(event, ${t.id}, this.getAttribute('data-task-name'), this.getAttribute('data-task-duration'), this.getAttribute('data-task-color'), this.getAttribute('data-task-group-id'))" data-task-id="${t.id}" data-task-type="assigned" data-task-duration="${t.duration || 'All Day'}" data-task-color="${t.color || 'color-1'}" data-task-name="${t.task_name.replace(/"/g, '&quot;')}" data-task-group-id="${t.group_id || ''}">
                                    ${t.task_name}${durationSuffix}
                                    <button class="delete-task-tag-btn" onclick="deleteAssignedTask(event, ${t.id}, '${t.group_id || ''}')" title="Remove Task">✖</button>
                                </div>
                                `;
                            }).join('') + `</div>`;
                    }

                    const isMultiRole = staffDailyRoles[dayDate][alloc.staff_name] > 1;
                    const multiRoleIcon = isMultiRole ? `<span title="Assigned to multiple roles today" style="font-size: 11px; margin-left: 4px; cursor: help;">⚠️</span>` : '';
                    
                    let shiftTimeHTML = '';
                    if (alloc.shift_time) {
                        shiftTimeHTML = `<div class="shift-time">🕒 ${alloc.shift_time}</div>`;
                    }

                    let statusBadge = '';
                    if (alloc.status === 'Training') statusBadge = '<div class="status-badge status-training">Training</div>';
                    else if (alloc.status === 'Assessment') statusBadge = '<div class="status-badge status-assessment">Assessment</div>';
                    else if (alloc.status === 'Unavailable') statusBadge = '<div class="status-badge status-unavailable">Unavailable</div>';
                    else if (alloc.status === 'Sick') statusBadge = '<div class="status-badge status-unavailable">Sick</div>';

                    let unavailableClass = (alloc.status === 'Unavailable' || alloc.status === 'Sick') ? ' chip-unavailable' : '';
                    let wfhIcon = alloc.status === 'WFH' ? '<div class="top-icon" title="Working From Home">🏠</div>' : '';
                    let sickIcon = alloc.status === 'Sick' ? '<div class="top-icon" title="Sick">🤢</div>' : '';
                    let trainingIcon = alloc.status === 'Training' ? '<div class="top-icon" title="Training">🧑‍🏫</div>' : '';
                    let assessmentIcon = alloc.status === 'Assessment' ? '<div class="top-icon" title="Assessment">📋</div>' : '';
                    let noteIcon = alloc.note ? `<div class="top-icon" title="${alloc.note.replace(/"/g, '&quot;')}">📄</div>` : '';

                    let draggableAttr = previewState.active ? '' : `draggable="true" ondragstart="dragStart(event, '${alloc.entry_id}')"`;
                    let isSelected = selectedShifts.has(String(alloc.entry_id)) ? ' selected-shift' : '';

                    cellHTML += `
                        <div class="${chipClass}${unavailableClass}${previewClasses}${isSelected}" style="${chipStyle}" ${draggableAttr} data-entry-id="${alloc.entry_id}" data-status="${alloc.status || 'Normal'}" data-note="${(alloc.note || '').replace(/"/g, '&quot;')}" data-staff-name="${alloc.staff_name.replace(/"/g, '&quot;')}">
                            <div class="chip-header">
                                <div class="staff-name">${alloc.staff_name}${multiRoleIcon}</div>
                                <div class="top-right-icons">
                                    ${wfhIcon}
                                    ${sickIcon}
                                    ${trainingIcon}
                                    ${assessmentIcon}
                                    ${noteIcon}
                                    ${!previewState.active ? `<button class="delete-btn" onclick="deleteShift('${alloc.entry_id}')" title="Remove Shift">✖</button>` : ''}
                                </div>
                            </div>
                            ${statusBadge}
                            ${shiftTimeHTML}
                            ${assignedTasksHTML}
                            ${previewControls}
                        </div>
                    `;
                    });
                }

                cellHTML += `</div>`;
                grid.innerHTML += cellHTML;
            });
        });

        weekBlock.appendChild(grid);
        container.appendChild(weekBlock);
    });
}

// Removes a specific shift from the roster completely
async function deleteShift(entryId) {
    if(!isAdmin) return;
    
    const entryIds = selectedShifts.has(String(entryId)) ? Array.from(selectedShifts) : [entryId];
    const msg = entryIds.length > 1 
        ? `Are you sure you want to remove these ${entryIds.length} staff members from their shifts?` 
        : `Are you sure you want to remove this staff member from this shift?`;
        
    if (!await customConfirm(msg)) return;
    
    try {
        const promises = entryIds.map(id => fetch(`/api/roster/shift/${id}`, { method: 'DELETE' }));
        const results = await Promise.all(promises);
        if (results.every(r => r.ok)) {
            clearSelection();
            loadRoster();
        } else {
            await customAlert('Failed to remove one or more shifts.');
        }
    } catch (err) {
        console.error("Error deleting shift:", err);
    }
}

async function addTask(date) {
    if(!isAdmin) return;
    
    const result = await showModal({
        title: 'Add New Task',
        type: 'multi-prompt',
        inputs: [
            { id: 'taskName', label: `Enter a new QA task for ${date}:`, defaultValue: '' },
            { id: 'duration', label: 'Enter duration in days:', defaultValue: '1', inputType: 'number' }
        ],
        checkbox: { label: 'Skip Weekends', checked: true }
    });
    
    if (!result || !result.action || !result.action.taskName || result.action.taskName.trim() === '') return;
    const taskName = result.action.taskName.trim();
    let durationDays = parseInt(result.action.duration);
    if (isNaN(durationDays) || durationDays < 1) durationDays = 1;
    const skipWeekends = result.checked;
    
    // Dynamically choose color 1 through 10 based on existing tasks for this day so they cycle through correctly
    const existingCount = document.querySelectorAll(`.grid-cell[data-date="${date}"] .task-chip`).length;
    const colors = ['color-1', 'color-2', 'color-3', 'color-4', 'color-5', 'color-6', 'color-7', 'color-8', 'color-9', 'color-10'];
    const nextColor = colors[existingCount % 10];
    
    const groupId = durationDays > 1 ? Date.now().toString() + Math.random().toString(36).substring(2, 7) : null;
    
    const promises = [];
    let currentLoopDate = new Date(date + 'T12:00:00Z');
    let daysAdded = 0;
    
    while (daysAdded < durationDays) {
        const dayOfWeek = currentLoopDate.getUTCDay();
        const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
        
        if (!skipWeekends || !isWeekend) {
            const targetDate = currentLoopDate.toISOString().split('T')[0];
            promises.push(fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: targetDate, task_name: taskName, color: nextColor, group_id: groupId, rosterType: currentRoster }) }));
            daysAdded++;
        }
        currentLoopDate.setUTCDate(currentLoopDate.getUTCDate() + 1);
    }
    await Promise.all(promises);
    loadRoster(); // Refresh the grid
}

// Removes a specific assigned task
async function deleteAssignedTask(ev, shiftTaskId, groupId) {
    if(!isAdmin) return;
    ev.stopPropagation(); 
    if (!await customConfirm('Are you sure you want to remove this task?')) return;

    try {
        const response = await fetch(`/api/roster/shift/task/${shiftTaskId}?mode=single`, { method: 'DELETE' });
        if (response.ok) loadRoster();
    } catch (err) {
        console.error("Error deleting assigned task:", err);
    }
}

async function deleteTask(taskId, ev, groupId) {
    if(!isAdmin) return;
    if (ev) ev.stopPropagation();
    let mode = 'single';
    if (groupId && groupId !== 'null' && groupId !== '') {
        const choice = await showModal({
            title: 'Delete Linked Task',
            message: 'This task is part of a multi-day linked series.\nDo you want to delete all linked tasks in the series, or just this one?',
            buttons: [
                { text: 'Delete All Linked', value: 'all', class: 'modal-btn-danger' },
                { text: 'Delete Just This One', value: 'single', class: 'modal-btn-primary' },
                { text: 'Cancel', value: null, class: 'modal-btn-secondary' }
            ]
        });
        if (!choice) return;
        mode = choice;
    } else {
        if (!await customConfirm('Are you sure you want to remove this task?')) return;
    }
    await fetch(`/api/tasks/${taskId}?mode=${mode}`, { method: 'DELETE' });
    loadRoster();
}

// --- HTML5 DRAG AND DROP FUNCTIONS ---
function dragStart(ev, entryId) {
    if(!isAdmin) { ev.preventDefault(); return; }
    ev.dataTransfer.setData("application/json", JSON.stringify({ type: 'shift', entry_id: entryId }));
}

function dragTaskStart(ev, taskId, taskName, duration, color, groupId) {
    if(!isAdmin) { ev.preventDefault(); return; }
    ev.dataTransfer.setData("application/json", JSON.stringify({ type: 'daily_task', task_id: taskId, task_name: taskName, duration: duration, color: color, group_id: groupId }));
}

function dragAssignedTaskStart(ev, shiftTaskId, taskName, duration, color, groupId) {
    if(!isAdmin) { ev.preventDefault(); return; }
    ev.stopPropagation(); 
    ev.dataTransfer.setData("application/json", JSON.stringify({ type: 'assigned_task', shift_task_id: shiftTaskId, task_name: taskName, duration: duration, color: color, group_id: groupId }));
}

function allowDrop(ev) {
    ev.preventDefault();
    const dropzone = ev.target.closest('.dropzone');
    const shiftChip = ev.target.closest('.allocation-chip');
    const emptyChip = ev.target.closest('.empty-chip');
    
    if (shiftChip || emptyChip) {
        const targetChip = shiftChip || emptyChip;
        let entryId = targetChip.getAttribute('data-entry-id');
        if (emptyChip) {
            entryId = `empty|${emptyChip.getAttribute('data-date')}|${emptyChip.getAttribute('data-role')}`;
        }
        
        if (selectedShifts.size > 0) {
            selectedShifts.forEach(id => {
                if (String(id).startsWith('empty|')) {
                    const parts = String(id).split('|');
                    document.querySelectorAll('.empty-chip').forEach(c => {
                        if (c.getAttribute('data-date') === parts[1] && c.getAttribute('data-role') === parts[2]) {
                            c.classList.add('drag-over-shift');
                        }
                    });
                } else {
                    const el = document.querySelector(`[data-entry-id='${id}']`);
                    if (el) el.classList.add('drag-over-shift');
                }
            });
            if (entryId && !selectedShifts.has(String(entryId))) {
                targetChip.classList.add('drag-over-shift');
            }
        } else {
            targetChip.classList.add('drag-over-shift');
        }
    } else if (dropzone) {
        dropzone.classList.add('drag-over');
    }
}

function dragLeave(ev) {
    const dropzone = ev.target.closest('.dropzone');
    const targetShiftChip = ev.target.closest('.allocation-chip');
    const emptyChip = ev.target.closest('.empty-chip');
    
    if (dropzone && (!ev.relatedTarget || !dropzone.contains(ev.relatedTarget))) {
        dropzone.classList.remove('drag-over');
    }
    if ((targetShiftChip && (!ev.relatedTarget || !targetShiftChip.contains(ev.relatedTarget))) || 
        (emptyChip && (!ev.relatedTarget || !emptyChip.contains(ev.relatedTarget)))) {
        document.querySelectorAll('.drag-over-shift').forEach(el => el.classList.remove('drag-over-shift'));
    }
}

async function drop(ev) {
    if(!isAdmin) return;
    ev.preventDefault();
    const dropzone = ev.target.closest('.dropzone');
    const targetShiftChip = ev.target.closest('.allocation-chip');
    const emptyChip = ev.target.closest('.empty-chip');
    
    if (dropzone) dropzone.classList.remove('drag-over');
    document.querySelectorAll('.drag-over-shift').forEach(el => el.classList.remove('drag-over-shift'));
    
    let data;
    try {
        data = JSON.parse(ev.dataTransfer.getData("application/json"));
    } catch(e) {
        const plainData = ev.dataTransfer.getData("text/plain");
        if (plainData && dropzone) {
            data = { type: 'shift', entry_id: plainData };
        } else {
            return;
        }
    }
    
    if (data.type === 'shift') {
        const draggedEntryId = data.entry_id;
        const draggedChip = document.querySelector(`[data-entry-id='${draggedEntryId}']`);

        if (dropzone && draggedChip) {
            const isSameDropzone = dropzone.isSameNode(draggedChip.parentElement);
            
            if (isSameDropzone) {
                // Reorder within the same dropzone
                if (targetShiftChip && draggedEntryId !== targetShiftChip.getAttribute('data-entry-id')) {
                    const rect = targetShiftChip.getBoundingClientRect();
                    const isAfter = ev.clientY > rect.top + rect.height / 2;
                    if (isAfter) {
                        dropzone.insertBefore(draggedChip, targetShiftChip.nextSibling);
                    } else {
                        dropzone.insertBefore(draggedChip, targetShiftChip);
                    }
                } else if (!targetShiftChip) {
                    // Dropped on the empty space of the dropzone, move to the end
                    dropzone.appendChild(draggedChip);
                }
                
                const newOrderChips = Array.from(dropzone.querySelectorAll('.allocation-chip'));
                const entryIds = newOrderChips.map(c => c.getAttribute('data-entry-id'));
                
                try {
                    const response = await fetch('/api/roster/shift/reorder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entry_ids: entryIds }) });
                    if (!response.ok) await customAlert('Failed to save the new order.'); 
                } catch (e) {
                    await customAlert('Error saving the new order.');
                }
                loadRoster();
                return;
            } else {
                // Move to a different dropzone entirely
                const newRole = dropzone.getAttribute('data-role');
                const newDate = dropzone.getAttribute('data-date');
                
                if (draggedEntryId && newRole && newDate) {
                    // Position it precisely where dropped so we can calculate the order accurately
                    if (targetShiftChip) {
                        const rect = targetShiftChip.getBoundingClientRect();
                        const isAfter = ev.clientY > rect.top + rect.height / 2;
                        if (isAfter) {
                            dropzone.insertBefore(draggedChip, targetShiftChip.nextSibling);
                        } else {
                            dropzone.insertBefore(draggedChip, targetShiftChip);
                        }
                    } else {
                        dropzone.appendChild(draggedChip);
                    }

                    const response = await fetch('/api/roster/shift/move', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ entry_id: draggedEntryId, new_date: newDate, new_shift_title: newRole })
                    });
                    
                    if (response.ok) {
                        const newOrderChips = Array.from(dropzone.querySelectorAll('.allocation-chip'));
                        const entryIds = newOrderChips.map(c => c.getAttribute('data-entry-id'));
                        await fetch('/api/roster/shift/reorder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entry_ids: entryIds }) });
                        loadRoster();
                    } else {
                        const result = await response.json();
                        await customAlert(result.error || 'Failed to move shift.');
                        loadRoster();
                    }
                }
            }
        }
        return;
    } else if ((data.type === 'daily_task' || data.type === 'assigned_task') && (targetShiftChip || emptyChip)) {
        if (targetShiftChip) {
            const targetEntryId = targetShiftChip.getAttribute('data-entry-id');
            if (!targetEntryId) return;
            
            const entryIds = getAffectedShifts(targetShiftChip);
            const validIds = entryIds.filter(id => !String(id).startsWith('empty|'));
            if (validIds.length === 0) return;

            if (data.type === 'daily_task') {
                const promises = validIds.map(id => fetch('/api/roster/shift/task', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ entry_id: id, task_name: data.task_name, duration: data.duration || 'All Day', color: data.color || 'color-1', group_id: data.group_id || null })
                }));
                const results = await Promise.all(promises);
                const failed = results.filter(r => !r.ok);
                if (failed.length === 0) {
                    clearSelection();
                    loadRoster();
                } else {
                    const result = await failed[0].json();
                    await customAlert(result.error || 'Failed to assign task to one or more shifts.');
                    loadRoster();
                }
            } else if (data.type === 'assigned_task') {
                const promises = validIds.map(id => {
                    if (id === targetEntryId) {
                        return fetch('/api/roster/shift/task/move', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ shift_task_id: data.shift_task_id, new_entry_id: id })
                        });
                    } else {
                        return fetch('/api/roster/shift/task', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ entry_id: id, task_name: data.task_name, duration: data.duration || 'All Day', color: data.color || 'color-1', group_id: data.group_id || null })
                        });
                    }
                });
                
                const results = await Promise.all(promises);
                const failed = results.filter(r => !r.ok);
                if (failed.length === 0) {
                    clearSelection();
                    loadRoster();
                } else {
                    const result = await failed[0].json();
                    await customAlert(result.error || 'Failed to move/assign task to one or more shifts.');
                    loadRoster();
                }
            }
        } else if (emptyChip) {
            const targetDate = emptyChip.getAttribute('data-date');
            const targetRole = emptyChip.getAttribute('data-role');
            const targetEntryId = `empty|${targetDate}|${targetRole}`;
            
            const entryIds = getAffectedShifts(emptyChip);
            const validEmptyIds = entryIds.filter(id => String(id).startsWith('empty|'));
            if (validEmptyIds.length === 0) return;

            if (data.type === 'daily_task') {
                const promises = validEmptyIds.map(id => {
                    const parts = String(id).split('|');
                    return fetch('/api/tasks/assign_missing', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            task_id: data.task_id, 
                            task_type: 'daily', 
                            date: parts[1], 
                            shift_title: parts[2],
                            task_name: data.task_name,
                            duration: data.duration,
                            color: data.color,
                            group_id: data.group_id || null
                        })
                    });
                });
                const results = await Promise.all(promises);
                const failed = results.filter(r => !r.ok);
                if (failed.length === 0) {
                    clearSelection();
                    loadRoster();
                } else {
                    const result = await failed[0].json();
                    await customAlert(result.error || 'Failed to assign task to missing assignment.');
                    loadRoster();
                }
            } else if (data.type === 'assigned_task') {
                const promises = validEmptyIds.map(id => {
                    const parts = String(id).split('|');
                    if (id === targetEntryId) {
                        return fetch('/api/tasks/assign_missing', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ 
                                task_id: data.shift_task_id, 
                                task_type: 'assigned', 
                                date: parts[1], 
                                shift_title: parts[2],
                                task_name: data.task_name,
                                duration: data.duration,
                                color: data.color,
                                group_id: data.group_id || null
                            })
                        });
                    } else {
                        return fetch('/api/tasks/assign_missing', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ 
                                task_id: null, 
                                task_type: 'daily', 
                                date: parts[1], 
                                shift_title: parts[2],
                                task_name: data.task_name,
                                duration: data.duration,
                                color: data.color,
                                group_id: data.group_id || null
                            })
                        });
                    }
                });
                
                const results = await Promise.all(promises);
                const failed = results.filter(r => !r.ok);
                if (failed.length === 0) {
                    clearSelection();
                    loadRoster();
                } else {
                    const result = await failed[0].json();
                    await customAlert(result.error || 'Failed to move/assign task to missing assignments.');
                    loadRoster();
                }
            }
        }
    }
}

async function updateStaffRole(name, newRole) {
    await fetch('/api/staff/role', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, role_category: newRole })
    });
    loadRoster(); // Dynamic grid redraw
}

async function editShiftTime(entryId, currentTime) {
    if(!isAdmin) return;
    const entryIds = selectedShifts.has(String(entryId)) ? Array.from(selectedShifts) : [entryId];
    const msg = entryIds.length > 1 
        ? `Enter shift time for ${entryIds.length} selected shifts (e.g. 09:00 - 17:00):`
        : "Enter shift time (e.g. 09:00 - 17:00):";
        
    const newTime = await customPrompt(msg, currentTime);
    if (newTime !== null) {
        const promises = entryIds.map(id => fetch('/api/roster/shift/time', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entry_id: id, new_shift_time: newTime.trim() })
        }));
        await Promise.all(promises);
        clearSelection();
        loadRoster();
    }
}

// --- PREVIEW FUNCTIONALITY ---
function renderPreviewControls() {
    let banner = document.getElementById('previewBanner');
    if (!previewState.active) {
        if (banner) banner.remove();
        return;
    }

    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'previewBanner';
        banner.className = 'preview-banner';
        
        const dashboard = document.getElementById('rotaDashboard');
        dashboard.parentNode.insertBefore(banner, dashboard);
    }

    const pendingCount = previewState.added.filter(a => a.previewStatus === 'pending').length +
                         previewState.deleted.filter(d => d.previewStatus === 'pending').length;

    banner.innerHTML = `
        <div>
            <span>🔍 <strong>Preview Mode (${previewState.mode.toUpperCase()})</strong> - ${pendingCount} pending change(s)</span>
        </div>
        <div>
            <button class="modal-btn modal-btn-secondary" onclick="previewAcceptAll()">Accept All Remaining</button>
            <button class="modal-btn modal-btn-secondary" onclick="previewDenyAll()">Reject All Remaining</button>
            <button class="modal-btn modal-btn-danger" onclick="cancelPreview()">Exit Preview</button>
        </div>
    `;
}

function checkPreviewFinished() {
    const pendingCount = previewState.added.filter(a => a.previewStatus === 'pending').length +
                         previewState.deleted.filter(d => d.previewStatus === 'pending').length;
    if (pendingCount === 0) {
        previewState.active = false;
        previewState.added = [];
        previewState.deleted = [];
        previewState.mode = null;
    }
}

window.previewAcceptAll = async function() {
    const pendingAdds = previewState.added.filter(a => a.previewStatus === 'pending');
    const pendingDeletes = previewState.deleted.filter(d => d.previewStatus === 'pending');
    
    if (pendingAdds.length === 0 && pendingDeletes.length === 0) return;

    try {
        const response = await fetch('/api/upload/apply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: previewState.mode, added: pendingAdds, deleted: pendingDeletes, rosterType: currentRoster })
        });
        const result = await response.json();
        if (result.success) {
            pendingAdds.forEach(a => a.previewStatus = 'accepted');
            pendingDeletes.forEach(d => d.previewStatus = 'accepted');
            checkPreviewFinished();
            renderPreviewControls();
            loadRoster();
        } else {
            await customAlert(result.error || "Failed to apply changes.");
        }
    } catch (err) {
        await customAlert("An error occurred while applying changes.");
    }
};

window.previewDenyAll = function() {
    previewState.added.forEach(a => { if (a.previewStatus === 'pending') a.previewStatus = 'denied'; });
    previewState.deleted.forEach(d => { if (d.previewStatus === 'pending') d.previewStatus = 'denied'; });
    checkPreviewFinished();
    renderPreviewControls();
    loadRoster();
};

window.acceptPreview = async function(ev, type, id) {
    ev.stopPropagation();
    const item = type === 'add' ? previewState.added.find(a => a.previewId === id) : previewState.deleted.find(d => d.previewId === id);
    if (!item) return;

    try {
        const added = type === 'add' ? [item] : [];
        const deleted = type === 'delete' ? [item] : [];
        
        const response = await fetch('/api/upload/apply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: previewState.mode, added, deleted, rosterType: currentRoster })
        });
        const result = await response.json();
        
        if (result.success) {
            item.previewStatus = 'accepted';
            checkPreviewFinished();
            renderPreviewControls();
            loadRoster();
        } else {
            await customAlert(result.error || "Failed to apply change.");
        }
    } catch (err) {
        await customAlert("An error occurred while applying change.");
    }
};

window.denyPreview = function(ev, type, id) {
    ev.stopPropagation();
    const item = type === 'add' ? previewState.added.find(a => a.previewId === id) : previewState.deleted.find(d => d.previewId === id);
    if (item) item.previewStatus = 'denied';
    checkPreviewFinished();
    renderPreviewControls();
    loadRoster();
};

window.cancelPreview = function() {
    previewState.active = false;
    previewState.added = [];
    previewState.deleted = [];
    previewState.mode = null;
    renderPreviewControls();
    loadRoster();
};

async function handleCmTaskEdit() {
    if (cmTarget.taskChip) {
        const taskId = cmTarget.taskChip.getAttribute('data-task-id');
        const taskType = cmTarget.taskChip.getAttribute('data-task-type');
        const currentName = cmTarget.taskChip.getAttribute('data-task-name');
        const groupId = cmTarget.taskChip.getAttribute('data-task-group-id');
        
        const newName = await customPrompt('Edit task name:', currentName);
        if (newName && newName.trim() !== '' && newName !== currentName) {
            let mode = 'all';
            if (taskType === 'assigned') {
                mode = 'single';
            } else if (groupId && groupId !== 'null' && groupId !== '') {
                const choice = await showModal({
                    title: 'Edit Linked Task Name',
                    message: 'This task is part of a multi-day linked series.\nDo you want to edit the name for all linked tasks in the series, or just this one?',
                    buttons: [
                        { text: 'Edit All Linked', value: 'all', class: 'modal-btn-danger' },
                        { text: 'Edit Just This One', value: 'single', class: 'modal-btn-primary' },
                        { text: 'Cancel', value: null, class: 'modal-btn-secondary' }
                    ]
                });
                if (!choice) return;
                mode = choice;
            }
            await fetch('/api/tasks/edit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ task_id: taskId, task_type: taskType, new_task_name: newName.trim(), mode })
            });
            loadRoster();
        }
    }
}

// --- CONTEXT MENU (COPY/PASTE & STATUS) ---
let clipboardData = null;
let cmTarget = null;

document.addEventListener('contextmenu', (e) => {
    if(!isAdmin) return;
    let shiftChip = e.target.closest('.allocation-chip');
    const taskChip = e.target.closest('.task-chip') || e.target.closest('.assigned-task-tag');
    const emptyChip = e.target.closest('.empty-chip');
    const dropzone = e.target.closest('.dropzone');
    const taskZone = e.target.closest('.tasks-cell');
    
    if (taskChip) shiftChip = null; // Prioritize task if clicked inside shift chip
    if (emptyChip) shiftChip = null;

    if (shiftChip || taskChip || emptyChip || dropzone || taskZone) {
        e.preventDefault();
        
        cmTarget = { shiftChip, taskChip, emptyChip, dropzone, taskZone };
        
        const menu = document.getElementById('contextMenu');
        menu.style.display = 'block';
        menu.style.left = e.pageX + 'px';
        menu.style.top = e.pageY + 'px';
        
        // Show/hide menu items based on target
        document.getElementById('cm-copy').style.display = (shiftChip || taskChip) ? 'block' : 'none';
        
        let canPaste = false;
        if (clipboardData) {
            if (clipboardData.type === 'shift' && dropzone) canPaste = true;
            if (clipboardData.type === 'task' && taskZone) canPaste = true;
        }
        document.getElementById('cm-paste').style.display = canPaste ? 'block' : 'none';
        
        const cmStatusItems = document.querySelectorAll('.cm-status');
        cmStatusItems.forEach(el => el.style.display = shiftChip ? 'block' : 'none');
        
        const cmShiftItems = document.querySelectorAll('.cm-shift');
        cmShiftItems.forEach(el => el.style.display = shiftChip ? 'block' : 'none');
        
        const isAssignedTask = taskChip && taskChip.classList.contains('assigned-task-tag');
        const cmTaskItems = document.querySelectorAll('.cm-task');
        cmTaskItems.forEach(el => {
            if (!taskChip) {
                el.style.display = 'none';
            } else if (isAssignedTask && el.id !== 'cm-task-am' && el.id !== 'cm-task-pm' && el.id !== 'cm-task-allday') {
                el.style.display = 'none';
            } else {
                el.style.display = 'block';
            }
        });
        
        const cmEmptyItems = document.querySelectorAll('.cm-empty');
        cmEmptyItems.forEach(el => el.style.display = emptyChip ? 'block' : 'none');
        
        const cmDropzoneItems = document.querySelectorAll('.cm-dropzone');
        cmDropzoneItems.forEach(el => el.style.display = (!shiftChip && !taskChip && !emptyChip && dropzone) ? 'block' : 'none');
        
        if (emptyChip) {
            const isIgnored = emptyChip.classList.contains('ignored');
            document.getElementById('cm-empty-ignore').innerHTML = (isIgnored ? '✓ ' : '&nbsp;&nbsp;&nbsp;') + 'Ignore';
        }
        
        if (shiftChip) {
            const currentStatus = shiftChip.getAttribute('data-status');
            document.getElementById('cm-status-training').innerHTML = (currentStatus === 'Training' ? '✓ ' : '&nbsp;&nbsp;&nbsp;') + 'Training';
            document.getElementById('cm-status-assessment').innerHTML = (currentStatus === 'Assessment' ? '✓ ' : '&nbsp;&nbsp;&nbsp;') + 'Assessment';
            document.getElementById('cm-status-unavailable').innerHTML = (currentStatus === 'Unavailable' ? '✓ ' : '&nbsp;&nbsp;&nbsp;') + 'Unavailable';
            document.getElementById('cm-status-wfh').innerHTML = (currentStatus === 'WFH' ? '✓ ' : '&nbsp;&nbsp;&nbsp;') + 'WFH';
            const sickEl = document.getElementById('cm-status-sick');
            if (sickEl) sickEl.innerHTML = (currentStatus === 'Sick' ? '✓ ' : '&nbsp;&nbsp;&nbsp;') + 'Sick';

            const currentNote = shiftChip.getAttribute('data-note') || '';
            const noteEl = document.getElementById('cm-shift-note');
            if (noteEl) {
                noteEl.innerText = currentNote ? 'Edit/Delete Note' : 'Add Note';
            }

            const shiftDropzone = shiftChip.closest('.dropzone');
            if (shiftDropzone) {
                const date = shiftDropzone.getAttribute('data-date');
                const dailyTasks = document.querySelectorAll(`.tasks-cell[data-date="${date}"] .task-chip`);
                const assignTaskMenu = document.getElementById('cm-shift-assign-task');
                const assignTaskSubmenu = document.getElementById('cm-assign-task-submenu');
                
                if (dailyTasks.length > 0) {
                    assignTaskMenu.style.display = 'block';
                    assignTaskSubmenu.innerHTML = Array.from(dailyTasks).map(t => {
                        const tName = t.getAttribute('data-task-name');
                        const tDur = t.getAttribute('data-task-duration') || 'All Day';
                        const tColor = t.getAttribute('data-task-color') || 'color-1';
                        const tGroupId = t.getAttribute('data-task-group-id') || '';
                        const safeName = tName.replace(/'/g, "\\'").replace(/"/g, "&quot;");
                        return `<div class="cm-item" onclick="handleCmAssignTask('${safeName}', '${tDur}', '${tColor}', '${tGroupId}')">${tName} (${tDur})</div>`;
                    }).join('');
                } else {
                    assignTaskMenu.style.display = 'none';
                }
            }
        }

        if (taskChip) {
            const currentDuration = taskChip.getAttribute('data-task-duration') || 'All Day';
            document.getElementById('cm-task-am').innerHTML = (currentDuration === 'AM' ? '✓ ' : '&nbsp;&nbsp;&nbsp;') + 'AM';
            document.getElementById('cm-task-pm').innerHTML = (currentDuration === 'PM' ? '✓ ' : '&nbsp;&nbsp;&nbsp;') + 'PM';
            document.getElementById('cm-task-allday').innerHTML = (currentDuration === 'All Day' ? '✓ ' : '&nbsp;&nbsp;&nbsp;') + 'All Day';
            
            const currentColor = taskChip.getAttribute('data-task-color') || 'color-1';
            document.getElementById('cm-task-color1').innerHTML = (currentColor === 'color-1' ? '✓ ' : '&nbsp;&nbsp;&nbsp;') + 'Orange';
            document.getElementById('cm-task-color2').innerHTML = (currentColor === 'color-2' ? '✓ ' : '&nbsp;&nbsp;&nbsp;') + 'Green';
            document.getElementById('cm-task-color3').innerHTML = (currentColor === 'color-3' ? '✓ ' : '&nbsp;&nbsp;&nbsp;') + 'Purple';
            document.getElementById('cm-task-color4').innerHTML = (currentColor === 'color-4' ? '✓ ' : '&nbsp;&nbsp;&nbsp;') + 'Blue';
            document.getElementById('cm-task-color5').innerHTML = (currentColor === 'color-5' ? '✓ ' : '&nbsp;&nbsp;&nbsp;') + 'Red';
            document.getElementById('cm-task-color6').innerHTML = (currentColor === 'color-6' ? '✓ ' : '&nbsp;&nbsp;&nbsp;') + 'Teal';
            document.getElementById('cm-task-color7').innerHTML = (currentColor === 'color-7' ? '✓ ' : '&nbsp;&nbsp;&nbsp;') + 'Pink';
            document.getElementById('cm-task-color8').innerHTML = (currentColor === 'color-8' ? '✓ ' : '&nbsp;&nbsp;&nbsp;') + 'Yellow';
            document.getElementById('cm-task-color9').innerHTML = (currentColor === 'color-9' ? '✓ ' : '&nbsp;&nbsp;&nbsp;') + 'Cyan';
            document.getElementById('cm-task-color10').innerHTML = (currentColor === 'color-10' ? '✓ ' : '&nbsp;&nbsp;&nbsp;') + 'Gray';
        }

    } else {
        const menu = document.getElementById('contextMenu');
        if (menu) menu.style.display = 'none';
    }
});

document.addEventListener('click', (e) => {
    const menu = document.getElementById('contextMenu');
    if (menu && menu.style.display === 'block') {
        menu.style.display = 'none';
    }

    const shiftChip = e.target.closest('.allocation-chip');
    const emptyChip = e.target.closest('.empty-chip');
    const activeChip = shiftChip || emptyChip;
    
    if (activeChip && e.shiftKey) {
        let entryId = activeChip.getAttribute('data-entry-id');
        if (emptyChip) entryId = `empty|${emptyChip.getAttribute('data-date')}|${emptyChip.getAttribute('data-role')}`;
        
        if (selectedShifts.has(String(entryId))) {
            selectedShifts.delete(String(entryId));
            setSelectionVisuals(entryId, false);
        } else {
            selectedShifts.add(String(entryId));
            setSelectionVisuals(entryId, true);
        }
        return;
    }

    if (!e.target.closest('.context-menu') && !e.target.closest('.modal-overlay') && !e.target.closest('.task-chip') && !e.target.closest('.assigned-task-tag')) {
        if (activeChip) {
            let entryId = activeChip.getAttribute('data-entry-id');
            if (emptyChip) entryId = `empty|${emptyChip.getAttribute('data-date')}|${emptyChip.getAttribute('data-role')}`;
            
            if (selectedShifts.has(String(entryId))) {
                if (!e.target.closest('button') && !e.target.closest('.assigned-task-tag')) {
                    clearSelection();
                    selectedShifts.add(String(entryId));
                    setSelectionVisuals(entryId, true);
                }
            } else {
                clearSelection();
                if (!e.target.closest('.assigned-task-tag')) {
                    selectedShifts.add(String(entryId));
                    setSelectionVisuals(entryId, true);
                }
            }
        } else {
            clearSelection();
        }
    }
});

function handleCmCopy() {
    if (cmTarget.shiftChip) {
        clipboardData = { type: 'shift', entry_id: cmTarget.shiftChip.getAttribute('data-entry-id') };
    } else if (cmTarget.taskChip) {
        clipboardData = { 
            type: 'task', 
            task_name: cmTarget.taskChip.getAttribute('data-task-name'),
            duration: cmTarget.taskChip.getAttribute('data-task-duration') || 'All Day',
            color: cmTarget.taskChip.getAttribute('data-task-color') || 'color-1',
            group_id: cmTarget.taskChip.getAttribute('data-task-group-id') || null
        };
    }
}

async function handleCmAddMissing() {
    if (cmTarget.dropzone) {
        const date = cmTarget.dropzone.getAttribute('data-date');
        const role = cmTarget.dropzone.getAttribute('data-role');
        await fetch('/api/metadata/manual', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date, shift_title: role, amount: 1, rosterType: currentRoster })
        });
        loadRoster();
    }
}

async function removeMissingAssignment(ev, date, role) {
    ev.stopPropagation();
    if(!isAdmin) return;
    const chip = ev.target.closest('.empty-chip');
    const entryIds = getAffectedShifts(chip);
    const promises = entryIds.map(id => {
        if (id.startsWith('empty|')) {
            const parts = id.split('|');
            return fetch('/api/metadata/manual', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: parts[1], shift_title: parts[2], amount: -1, rosterType: currentRoster })
            });
        }
    });
    await Promise.all(promises.filter(Boolean));
    clearSelection();
    loadRoster();
}

async function handleCmPaste() {
    if (!clipboardData) return;
    
    if (clipboardData.type === 'shift' && cmTarget.dropzone) {
        const newDate = cmTarget.dropzone.getAttribute('data-date');
        const newRole = cmTarget.dropzone.getAttribute('data-role');
        
        const response = await fetch('/api/roster/shift/duplicate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source_entry_id: clipboardData.entry_id, new_date: newDate, new_shift_title: newRole })
        });
        if (response.ok) {
            loadRoster();
        } else {
            const res = await response.json();
            await customAlert(res.error || 'Failed to paste shift.');
        }
    } else if (clipboardData.type === 'task' && cmTarget.taskZone) {
        const date = cmTarget.taskZone.getAttribute('data-date');
        if (date) {
            await fetch('/api/tasks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ date, task_name: clipboardData.task_name, duration: clipboardData.duration, color: clipboardData.color, group_id: clipboardData.group_id || null, rosterType: currentRoster })
            });
            loadRoster();
        }
    }
}

async function handleCmStatusToggle(statusClicked) {
    if (cmTarget.shiftChip) {
        const entryIds = getAffectedShifts(cmTarget.shiftChip);
        const validIds = entryIds.filter(id => !String(id).startsWith('empty|'));
        if (validIds.length === 0) return;
        
        const isSingle = validIds.length === 1;
        const currentStatus = cmTarget.shiftChip.getAttribute('data-status');
        const newStatus = (isSingle && currentStatus === statusClicked) ? 'Normal' : statusClicked;

        const promises = validIds.map(id => fetch('/api/roster/shift/status', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entry_id: id, status: newStatus })
        }));
        await Promise.all(promises);
        clearSelection();
        loadRoster();
    }
}

function handleCmNoteAction() {
    if (cmTarget && cmTarget.shiftChip) {
        const entryId = cmTarget.shiftChip.getAttribute('data-entry-id');
        const currentNote = cmTarget.shiftChip.getAttribute('data-note') || '';
        handleCmNote(entryId, currentNote);
    }
}

async function handleCmNote(entryId, currentNote) {
    if (!isAdmin) return;
    const entryIds = selectedShifts.has(String(entryId)) ? Array.from(selectedShifts) : [entryId];
    const msg = entryIds.length > 1 
        ? `Enter note for ${entryIds.length} selected shifts (leave blank to delete):`
        : "Enter note (leave blank to delete):";
        
    const newNote = await customPrompt(msg, currentNote);
    if (newNote !== null) {
        const promises = entryIds.map(id => fetch('/api/roster/shift/note', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entry_id: id, note: newNote.trim() })
        }));
        await Promise.all(promises);
        clearSelection();
        loadRoster();
    }
}

async function handleCmComment() {
    if (cmTarget.emptyChip) {
        const entryIds = getAffectedShifts(cmTarget.emptyChip);
        const comment = await customPrompt('Enter comment for this missing assignment:');
        if (comment !== null) {
            const promises = entryIds.map(id => {
                if (id.startsWith('empty|')) {
                    const parts = id.split('|');
                    return fetch('/api/metadata/comment', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: parts[1], shift_title: parts[2], comment, rosterType: currentRoster })
                    });
                }
            });
            await Promise.all(promises.filter(Boolean));
            clearSelection();
            loadRoster();
        }
    }
}

async function handleCmIgnore() {
    if (cmTarget.emptyChip) {
        const entryIds = getAffectedShifts(cmTarget.emptyChip);
        const isIgnored = cmTarget.emptyChip.classList.contains('ignored') ? 0 : 1;
        const promises = entryIds.map(id => {
            if (id.startsWith('empty|')) {
                const parts = id.split('|');
                return fetch('/api/metadata/ignore', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: parts[1], shift_title: parts[2], is_ignored: isIgnored, rosterType: currentRoster })
                });
            }
        });
        await Promise.all(promises.filter(Boolean));
        clearSelection();
        loadRoster();
    }
}

async function handleCmAssign(staffName) {
    if (cmTarget.emptyChip) {
        const entryIds = getAffectedShifts(cmTarget.emptyChip);
        const promises = entryIds.map(id => {
            if (id.startsWith('empty|')) {
                const parts = id.split('|');
                return fetch('/api/roster/shift/assign', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ staff_name: staffName, date: parts[1], shift_title: parts[2], rosterType: currentRoster })
                });
            }
        });
        const results = await Promise.all(promises.filter(Boolean));
        const failed = results.filter(r => !r.ok);
        
        if (failed.length === 0) {
            clearSelection();
            loadRoster();
        } else {
            const errorJson = await failed[0].json();
            await customAlert(errorJson.error || 'Failed to assign user to one or more shifts.');
            loadRoster();
        }
    }
}

async function handleCmSwap(staffName) {
    if (cmTarget.shiftChip) {
        const entryIds = getAffectedShifts(cmTarget.shiftChip);
        const validIds = entryIds.filter(id => !String(id).startsWith('empty|'));
        if (validIds.length === 0) return;
        const promises = validIds.map(id => fetch('/api/roster/shift/swap', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entry_id: id, new_staff_name: staffName })
        }));
        const results = await Promise.all(promises);
        const failed = results.filter(r => !r.ok);
        
        if (failed.length === 0) {
            clearSelection();
            loadRoster();
        } else {
            const errorJson = await failed[0].json();
            await customAlert(errorJson.error || 'Failed to swap user for one or more shifts.');
            loadRoster();
        }
    }
}

async function handleCmAssignTask(taskName, duration, color, groupId) {
    if (cmTarget.shiftChip) {
        const entryIds = getAffectedShifts(cmTarget.shiftChip);
        const validIds = entryIds.filter(id => !String(id).startsWith('empty|'));
        if (validIds.length === 0) return;
        const promises = validIds.map(id => fetch('/api/roster/shift/task', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entry_id: id, task_name: taskName, duration: duration, color: color, group_id: groupId || null })
        }));
        
        const results = await Promise.all(promises);
        const failed = results.filter(r => !r.ok);
        
        if (failed.length === 0) {
            clearSelection();
            loadRoster();
        } else {
            const errorJson = await failed[0].json();
            await customAlert(errorJson.error || 'Failed to assign task to one or more shifts.');
            loadRoster();
        }
    }
}

async function handleCmAdd(staffName) {
    if (cmTarget.dropzone) {
        const date = cmTarget.dropzone.getAttribute('data-date');
        const role = cmTarget.dropzone.getAttribute('data-role');
        const response = await fetch('/api/roster/shift/assign', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ staff_name: staffName, date, shift_title: role, rosterType: currentRoster })
        });
        if (!response.ok) {
            const result = await response.json();
            await customAlert(result.error || 'Failed to add user.');
        } else {
            loadRoster();
        }
    }
}

async function handleCmTaskColor(color) {
    if (cmTarget.taskChip) {
        const taskId = cmTarget.taskChip.getAttribute('data-task-id');
        const taskType = cmTarget.taskChip.getAttribute('data-task-type');
        const groupId = cmTarget.taskChip.getAttribute('data-task-group-id');
        
        let mode = 'all';
        if (taskType === 'assigned') {
            mode = 'single';
        } else if (groupId && groupId !== 'null' && groupId !== '') {
            const choice = await showModal({
                title: 'Edit Linked Task Color',
                message: 'This task is part of a multi-day linked series.\nDo you want to change the color for all linked tasks in the series, or just this one?',
                buttons: [
                    { text: 'Edit All Linked', value: 'all', class: 'modal-btn-danger' },
                    { text: 'Edit Just This One', value: 'single', class: 'modal-btn-primary' },
                    { text: 'Cancel', value: null, class: 'modal-btn-secondary' }
                ]
            });
            if (!choice) return;
            mode = choice;
        }
        
        const endpoint = taskType === 'daily' ? '/api/tasks/color' : '/api/roster/shift/task/color';
        const body = taskType === 'daily' ? { task_id: taskId, color, mode } : { shift_task_id: taskId, color, mode };

        await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        loadRoster();
    }
}

async function handleCmTaskDuration(duration) {
    if (cmTarget.taskChip) {
        const taskId = cmTarget.taskChip.getAttribute('data-task-id');
        const taskType = cmTarget.taskChip.getAttribute('data-task-type');
        const groupId = cmTarget.taskChip.getAttribute('data-task-group-id');
        
        let mode = 'all';
        if (taskType === 'assigned') {
            mode = 'single';
        } else if (groupId && groupId !== 'null' && groupId !== '') {
            const choice = await showModal({
                title: 'Edit Linked Task Duration',
                message: 'This task is part of a multi-day linked series.\nDo you want to change the duration for all linked tasks in the series, or just this one?',
                buttons: [
                    { text: 'Edit All Linked', value: 'all', class: 'modal-btn-danger' },
                    { text: 'Edit Just This One', value: 'single', class: 'modal-btn-primary' },
                    { text: 'Cancel', value: null, class: 'modal-btn-secondary' }
                ]
            });
            if (!choice) return;
            mode = choice;
        }
        
        const endpoint = taskType === 'daily' ? '/api/tasks/duration' : '/api/roster/shift/task/duration';
        const body = taskType === 'daily' ? { task_id: taskId, duration, mode } : { shift_task_id: taskId, duration, mode };

        await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        loadRoster();
    }
}

// --- HIGHLIGHT LINKED TASKS & USER SHIFTS ON HOVER ---
document.addEventListener('mouseover', (e) => {
    const taskChip = e.target.closest('.task-chip, .assigned-task-tag');
    if (taskChip) {
        const groupId = taskChip.getAttribute('data-task-group-id');
        if (groupId && groupId !== 'null' && groupId !== '') {
            document.querySelectorAll(`[data-task-group-id="${groupId}"]`).forEach(el => {
                el.classList.add('linked-task-hover');
            });
        }
    }
    
    const staffNameEl = e.target.closest('.staff-name');
    if (staffNameEl) {
        const allocChip = staffNameEl.closest('.allocation-chip');
        if (allocChip) {
            const staffName = allocChip.getAttribute('data-staff-name');
            if (staffName) {
                document.querySelectorAll('.allocation-chip').forEach(chip => {
                    if (chip.getAttribute('data-staff-name') === staffName) {
                        chip.classList.add('linked-task-hover');
                    }
                });
            }
        }
    }
});
document.addEventListener('mouseout', (e) => {
    const taskChip = e.target.closest('.task-chip, .assigned-task-tag');
    if (taskChip) {
        const groupId = taskChip.getAttribute('data-task-group-id');
        if (groupId && groupId !== 'null' && groupId !== '') {
            document.querySelectorAll(`[data-task-group-id="${groupId}"]`).forEach(el => {
                el.classList.remove('linked-task-hover');
            });
        }
    }
    
    const staffNameEl = e.target.closest('.staff-name');
    if (staffNameEl) {
        const allocChip = staffNameEl.closest('.allocation-chip');
        if (allocChip) {
            const staffName = allocChip.getAttribute('data-staff-name');
            if (staffName) {
                document.querySelectorAll('.allocation-chip').forEach(chip => {
                    if (chip.getAttribute('data-staff-name') === staffName) {
                        chip.classList.remove('linked-task-hover');
                    }
                });
            }
        }
    }
});

const dynamicStyle = document.createElement('style');
dynamicStyle.innerHTML = `
    .linked-task-hover {
        box-shadow: 0 0 0 2px #ecc94b, 0 0 8px 2px rgba(236, 201, 75, 0.6) !important;
        filter: brightness(1.1);
        transform: scale(1.03);
        transition: transform 0.1s ease, box-shadow 0.1s ease;
        z-index: 10;
        position: relative;
    }
    .selected-shift {
        box-shadow: 0 0 0 3px #63b3ed, 0 0 8px 2px rgba(99, 179, 237, 0.8) !important;
        filter: brightness(1.1);
        transform: scale(1.02);
        transition: transform 0.1s ease, box-shadow 0.1s ease;
        z-index: 10;
        position: relative;
    }
    .drag-over-shift {
        outline: 2px dashed #000 !important;
        outline-offset: 2px;
        opacity: 0.8;
    }
    .dt-header.collapsed {
        grid-column: span 8;
    }
    .tasks-cell.collapsed {
        display: none;
    }
    .top-right-icons {
        display: flex;
        align-items: center;
        gap: 4px;
    }
    .top-right-icons .top-icon {
        position: static !important;
        margin: 0;
        padding: 0;
        cursor: help;
        font-size: 12px;
    }
`;
document.head.appendChild(dynamicStyle);

// --- REAL-TIME UPDATES (Socket.io) ---
const socket = typeof io !== 'undefined' ? io() : null;

if (socket) {
    socket.on('roster_updated', () => {
        if (isUserBusy()) {
            showLiveUpdateBanner();
        } else {
            // If the user isn't interacting, just reload the grid seamlessly
            loadRoster();
        }
    });
}

function isUserBusy() {
    if (previewState.active) return true;
    const customModal = document.getElementById('customModal');
    if (customModal && customModal.style.display === 'flex') return true;
    const staffModal = document.getElementById('staffModal');
    if (staffModal && staffModal.style.display === 'flex') return true;
    const ctxMenu = document.getElementById('contextMenu');
    if (ctxMenu && ctxMenu.style.display === 'block') return true;
    if (document.querySelectorAll('.drag-over-shift, .drag-over, .selected-shift').length > 0) return true;
    return false;
}

function showLiveUpdateBanner() {
    let banner = document.getElementById('liveUpdateBanner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'liveUpdateBanner';
        banner.className = 'preview-banner';
        banner.style.borderColor = '#3182ce';
        banner.style.backgroundColor = '#ebf8ff';
        banner.style.color = '#2b6cb0';
        banner.innerHTML = `
            <div>
                <span>🔄 <strong>Real-time Update Available</strong> - A colleague has made changes.</span>
            </div>
            <div>
                <button class="modal-btn modal-btn-primary" onclick="applyLiveUpdate()">Refresh Now</button>
            </div>
        `;
        const dashboard = document.getElementById('rotaDashboard');
        dashboard.parentNode.insertBefore(banner, dashboard);
    }
}

window.applyLiveUpdate = function() {
    const banner = document.getElementById('liveUpdateBanner');
    if (banner) banner.remove();
    clearSelection();
    loadRoster();
};