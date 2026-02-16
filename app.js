/**
 * NOW OR NEVER - Application Logic
 * @version 1.1.0
 * 
 * Implements:
 * - Auto-delete at T=0 with Graveyard migration
 * - Graveyard (24-hour recovery cache)
 * - Haptic feedback system
 * - Glitch effects for urgency states
 * - Shatter animation on expiration
 */
'use strict';

// Constants
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60000;
const MS_PER_HOUR = 3600000;
const CRITICAL_THRESHOLD = 15 * MS_PER_MINUTE;
const ELEVATED_THRESHOLD = 2 * MS_PER_HOUR;
const MAX_TASK_NAME_LENGTH = 200;
const STORAGE_KEY_PREFIX = 'non-';
const GRAVEYARD_DURATION = 24 * MS_PER_HOUR; // 24 hours
const RESURRECT_HOLD_DURATION = 3000; // 3 seconds hold to resurrect

// State color mapping (single source of truth)
const STATE_COLORS = {
  STABLE: { color: '#00ffff', bg: 'rgba(0, 255, 255, 0.13)' },
  ELEVATED: { color: '#ff8800', bg: 'rgba(255, 136, 0, 0.13)' },
  CRITICAL: { color: '#ff0044', bg: 'rgba(255, 0, 68, 0.13)' },
  TERMINAL: { color: '#ff0044', bg: 'rgba(255, 0, 68, 0.13)' }
};

// State
let tasks = [];
let graveyard = [];
let completedCount = 0;
let expiredCount = 0;
let streak = 0;
let selectedMins = 60;
let hfTask = null;
let timerInterval = null;
let graveyardTimers = {};
let resurrectHoldTimers = {};
let wakeLock = null;
let longPressTimer = null;
let settings = {
  sound: true,
  haptic: true,
  graveyard: true,
  defaultTime: 60
};

// ==================== HAPTIC FEEDBACK SYSTEM ====================

/**
 * Trigger haptic feedback with graceful fallback
 * @param {string} pattern - 'success', 'failure', 'critical', 'heartbeat'
 */
function triggerHaptic(pattern) {
  // Check if haptic is enabled in settings
  if (!settings.haptic) return;
  if (!navigator.vibrate) return; // Graceful fallback
  
  const patterns = {
    success: [50],                          // Single sharp pulse
    failure: [100, 50, 100],                // Double pulse
    critical: [30, 100, 30, 100, 30],       // Triple urgent pulse
    heartbeat: [50, 100, 50, 100, 50],      // Heartbeat pattern
    shatter: [20, 20, 20, 20, 20, 20, 20]   // Rapid shatter vibration
  };
  
  const vibrationPattern = patterns[pattern] || patterns.success;
  navigator.vibrate(vibrationPattern);
}

/**
 * Start rhythmic haptic for critical state
 * @param {string} taskId - Task ID to track
 */
function startCriticalHaptic(taskId) {
  // Will be implemented with interval tracking
}

// ==================== WAKE LOCK FOR HYPER-FOCUS ====================

/**
 * Request Wake Lock to prevent screen from sleeping
 * @returns {Promise<boolean>} Whether wake lock was acquired
 */
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) {
    console.log('[WakeLock] API not supported');
    return false;
  }
  
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    console.log('[WakeLock] Acquired');
    
    // Show indicator
    showWakeLockIndicator();
    
    // Handle visibility change - reacquire on tab focus
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    return true;
  } catch (err) {
    console.warn('[WakeLock] Failed to acquire:', err.message);
    return false;
  }
}

/**
 * Release Wake Lock
 */
async function releaseWakeLock() {
  if (wakeLock) {
    try {
      await wakeLock.release();
      wakeLock = null;
      console.log('[WakeLock] Released');
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    } catch (err) {
      console.warn('[WakeLock] Failed to release:', err.message);
    }
  }
}

/**
 * Handle visibility change - reacquire wake lock when tab becomes visible
 */
async function handleVisibilityChange() {
  if (document.visibilityState === 'visible' && hfTask) {
    await requestWakeLock();
  }
}

/**
 * Show wake lock indicator in Hyper-Focus mode
 */
function showWakeLockIndicator() {
  // Remove existing indicator
  const existing = document.querySelector('.wake-lock-indicator');
  if (existing) existing.remove();
  
  const indicator = document.createElement('div');
  indicator.className = 'wake-lock-indicator';
  indicator.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
    </svg>
    Screen awake
  `;
  document.body.appendChild(indicator);
  
  // Auto-remove after 2 seconds
  setTimeout(() => {
    if (indicator.parentNode) indicator.remove();
  }, 2000);
}

// ==================== SETTINGS ====================

/**
 * Open settings modal
 */
function openSettings() {
  const modal = document.getElementById('settings-modal');
  modal.classList.add('active');
  
  // Update UI with current settings
  document.getElementById('setting-sound').checked = settings.sound;
  document.getElementById('setting-haptic').checked = settings.haptic;
  document.getElementById('setting-graveyard').checked = settings.graveyard;
  document.getElementById('setting-default-time').value = settings.defaultTime;
}

/**
 * Close settings modal
 */
function closeSettings() {
  document.getElementById('settings-modal').classList.remove('active');
}

/**
 * Update a setting and persist
 * @param {string} key - Setting key
 * @param {*} value - Setting value
 */
function updateSetting(key, value) {
  settings[key] = value;
  saveState();
  
  // Apply immediate effects
  if (key === 'defaultTime') {
    selectedMins = value;
  }
}

/**
 * Clear all app data
 */
function clearAllData() {
  if (confirm('Are you sure you want to delete all data? This cannot be undone.')) {
    tasks = [];
    graveyard = [];
    completedCount = 0;
    expiredCount = 0;
    streak = 0;
    
    // Clear localStorage
    Object.keys(localStorage).forEach(key => {
      if (key.startsWith(STORAGE_KEY_PREFIX)) {
        localStorage.removeItem(key);
      }
    });
    
    renderAll();
    renderGraveyard();
    updateStats();
    closeSettings();
    showBurst('failure');
    triggerHaptic('failure');
  }
}

// ==================== LONG-PRESS RAPID ENTRY ====================

const LONG_PRESS_DURATION = 500; // 500ms

/**
 * Start long-press timer on New Mission button
 */
function startLongPress() {
  const btn = document.getElementById('new-task-btn');
  btn.classList.add('long-pressing');
  
  longPressTimer = setTimeout(() => {
    // Haptic feedback for long-press recognition
    triggerHaptic('success');
    showQuickPresets();
  }, LONG_PRESS_DURATION);
}

/**
 * Cancel long-press timer
 */
function cancelLongPress() {
  const btn = document.getElementById('new-task-btn');
  btn.classList.remove('long-pressing');
  
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
}

/**
 * Show quick presets menu
 */
function showQuickPresets() {
  document.getElementById('quick-presets').classList.add('active');
}

/**
 * Hide quick presets menu
 */
function hideQuickPresets() {
  document.getElementById('quick-presets').classList.remove('active');
}

/**
 * Add task with specific time preset (for rapid entry)
 * @param {number} mins - Minutes until deadline
 */
function addQuickTask(mins) {
  const input = document.getElementById('task-input');
  const name = input.value.trim().slice(0, MAX_TASK_NAME_LENGTH);
  
  if (!name) {
    // If no name, open modal with preset time selected
    selectedMins = mins;
    openModal();
    updatePresetSelection(mins);
  } else {
    // Create task directly with the preset time
    const now = Date.now();
    const newTask = {
      id: now.toString(36) + Math.random().toString(36).slice(2, 6),
      name: name,
      deadline: now + mins * MS_PER_MINUTE,
      created: now
    };
    
    tasks.push(newTask);
    renderAll();
    closeModal();
    showBurst('success');
    triggerHaptic('success');
  }
  
  hideQuickPresets();
}

/**
 * Update preset button selection in modal
 * @param {number} mins - Minutes to select
 */
function updatePresetSelection(mins) {
  document.querySelectorAll('.time-preset').forEach(btn => {
    btn.classList.toggle('selected', parseInt(btn.dataset.mins, 10) === mins);
  });
  selectedMins = mins;
}

// ==================== STORAGE HELPERS ====================

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY_PREFIX + 'tasks', JSON.stringify(tasks));
    localStorage.setItem(STORAGE_KEY_PREFIX + 'graveyard', JSON.stringify(graveyard));
    localStorage.setItem(STORAGE_KEY_PREFIX + 'completed', completedCount.toString());
    localStorage.setItem(STORAGE_KEY_PREFIX + 'expired', expiredCount.toString());
    localStorage.setItem(STORAGE_KEY_PREFIX + 'streak', streak.toString());
    localStorage.setItem(STORAGE_KEY_PREFIX + 'settings', JSON.stringify(settings));
  } catch (e) {
    console.warn('Failed to save state to localStorage:', e);
    if (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014) {
      showStorageNotification('Storage quota exceeded. Please delete some tasks or clear browser data.');
    }
  }
}

function loadState() {
  try {
    const savedTasks = localStorage.getItem(STORAGE_KEY_PREFIX + 'tasks');
    if (savedTasks) {
      tasks = JSON.parse(savedTasks);
      tasks = tasks.filter(t =>
        t &&
        typeof t.id === 'string' &&
        typeof t.name === 'string' &&
        typeof t.deadline === 'number' &&
        typeof t.created === 'number'
      );
    }
    
    const savedGraveyard = localStorage.getItem(STORAGE_KEY_PREFIX + 'graveyard');
    if (savedGraveyard) {
      graveyard = JSON.parse(savedGraveyard);
      graveyard = graveyard.filter(g =>
        g &&
        typeof g.id === 'string' &&
        typeof g.name === 'string' &&
        typeof g.expiredAt === 'number'
      );
    }
    
    completedCount = parseInt(localStorage.getItem(STORAGE_KEY_PREFIX + 'completed'), 10) || 0;
    expiredCount = parseInt(localStorage.getItem(STORAGE_KEY_PREFIX + 'expired'), 10) || 0;
    streak = parseInt(localStorage.getItem(STORAGE_KEY_PREFIX + 'streak'), 10) || 0;
    
    // Load settings
    const savedSettings = localStorage.getItem(STORAGE_KEY_PREFIX + 'settings');
    if (savedSettings) {
      const parsed = JSON.parse(savedSettings);
      settings = { ...settings, ...parsed };
      selectedMins = settings.defaultTime;
    }
  } catch (e) {
    console.warn('Failed to load state from localStorage:', e);
    tasks = [];
    graveyard = [];
    completedCount = 0;
    expiredCount = 0;
    streak = 0;
  }
}

function showStorageNotification(message) {
  const existing = document.querySelector('.storage-notification');
  if (existing) existing.remove();
  
  const notification = document.createElement('div');
  notification.className = 'storage-notification';
  notification.textContent = message;
  notification.setAttribute('role', 'alert');
  notification.setAttribute('aria-live', 'assertive');
  
  document.body.appendChild(notification);
  
  setTimeout(() => {
    if (notification.parentNode) notification.remove();
  }, 5000);
}

// ==================== XSS PREVENTION ====================

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ==================== STATE MANAGEMENT ====================

function getState(deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return 'TERMINAL';
  if (remaining <= MS_PER_MINUTE) return 'TERMINAL';
  if (remaining <= CRITICAL_THRESHOLD) return 'CRITICAL';
  if (remaining <= ELEVATED_THRESHOLD) return 'ELEVATED';
  return 'STABLE';
}

function formatTime(deadline) {
  const remaining = Math.max(0, deadline - Date.now());
  const hours = Math.floor(remaining / MS_PER_HOUR);
  const minutes = Math.floor((remaining % MS_PER_HOUR) / MS_PER_MINUTE);
  const seconds = Math.floor((remaining % MS_PER_MINUTE) / MS_PER_SECOND);
  if (hours > 0) {
    return hours + ':' + String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
  }
  return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
}

function formatGraveyardTime(expiredAt) {
  const remaining = Math.max(0, GRAVEYARD_DURATION - (Date.now() - expiredAt));
  const hours = Math.floor(remaining / MS_PER_HOUR);
  const minutes = Math.floor((remaining % MS_PER_HOUR) / MS_PER_MINUTE);
  return `${hours}h ${minutes}m left`;
}

function getProgress(deadline, created) {
  const total = deadline - created;
  if (total <= 0) return 0;
  const elapsed = Date.now() - created;
  return Math.max(0, Math.min(100, 100 - (elapsed / total) * 100));
}

// ==================== AUTO-DELETE & GRAVEYARD ====================

/**
 * Handle task expiration at T=0
 * Triggers shatter animation and migrates to graveyard
 * @param {object} task - The expired task
 */
function handleTaskExpiration(task) {
  // Trigger shatter animation
  const card = document.getElementById('task-' + task.id);
  if (card) {
    card.classList.add('shattering');
    showBurst('shatter');
    triggerHaptic('shatter');
  }
  
  // Remove from active tasks after animation
  setTimeout(() => {
    tasks = tasks.filter(t => t.id !== task.id);
    
    // Add to graveyard
    const graveTask = {
      id: task.id,
      name: task.name,
      deadline: task.deadline,
      created: task.created,
      expiredAt: Date.now()
    };
    graveyard.push(graveTask);
    
    // Update stats
    expiredCount++;
    streak = 0;
    
    updateStats();
    renderAll();
    renderGraveyard();
    saveState();
  }, 300); // Match shatter animation duration
}

/**
 * Check for expired tasks and process them
 */
function checkForExpiredTasks() {
  const now = Date.now();
  const expiredTasks = tasks.filter(t => t.deadline <= now);
  
  expiredTasks.forEach(task => {
    handleTaskExpiration(task);
  });
}

/**
 * Check for graveyard items that have exceeded 24 hours
 */
function checkGraveyardExpiration() {
  const now = Date.now();
  const expiredGraves = graveyard.filter(g => 
    (now - g.expiredAt) >= GRAVEYARD_DURATION
  );
  
  if (expiredGraves.length > 0) {
    graveyard = graveyard.filter(g => 
      (now - g.expiredAt) < GRAVEYARD_DURATION
    );
    renderGraveyard();
    saveState();
  }
}

/**
 * Resurrect a task from the graveyard
 * @param {string} graveId - The grave task ID
 */
function resurrectTask(graveId) {
  const grave = graveyard.find(g => g.id === graveId);
  if (!grave) return;
  
  // Create new task with same duration offset
  const originalDuration = grave.deadline - grave.created;
  const now = Date.now();
  
  const resurrectedTask = {
    id: now.toString(36) + Math.random().toString(36).slice(2, 6),
    name: grave.name,
    deadline: now + originalDuration,
    created: now
  };
  
  // Remove from graveyard
  graveyard = graveyard.filter(g => g.id !== graveId);
  
  // Add to active tasks
  tasks.push(resurrectedTask);
  
  // Visual feedback
  triggerHaptic('success');
  showBurst('success');
  
  renderAll();
  renderGraveyard();
  saveState();
}

/**
 * Permanently delete a grave task
 * @param {string} graveId - The grave task ID
 */
function permanentlyDeleteGrave(graveId) {
  graveyard = graveyard.filter(g => g.id !== graveId);
  renderGraveyard();
  saveState();
}

// ==================== RENDERING ====================

function renderAll() {
  tasks.sort((a, b) => (a.deadline - Date.now()) - (b.deadline - Date.now()));

  const container = document.getElementById('task-list');
  container.innerHTML = tasks.map(t => {
    const state = getState(t.deadline);
    const escapedName = escapeHtml(t.name);
    return `
      <li class="task-card ${state}" id="task-${t.id}">
        <div class="task-header">
          <div class="task-status">${state}</div>
          <button type="button" class="focus-btn" data-task-id="${t.id}" aria-label="Focus on ${escapedName}">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <title>Focus</title>
              <circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4m10-10h-4M6 12H2"/>
            </svg>
          </button>
        </div>
        <h3 class="task-name">${escapedName}</h3>
        <div class="task-timer">
          <span class="timer-label">Time Left</span>
          <span class="timer-value" data-deadline="${t.deadline}" aria-live="off">${formatTime(t.deadline)}</span>
        </div>
        <div class="progress-bar" role="progressbar" aria-valuenow="${Math.round(getProgress(t.deadline, t.created))}" aria-valuemin="0" aria-valuemax="100">
          <div class="progress-fill" style="width:${getProgress(t.deadline, t.created)}%" data-deadline="${t.deadline}" data-created="${t.created}"></div>
        </div>
        <div class="task-actions">
          <button type="button" class="btn btn-delete" data-task-id="${t.id}" aria-label="Delete ${escapedName}">× Delete</button>
          <button type="button" class="btn btn-complete" data-task-id="${t.id}" aria-label="Complete ${escapedName}">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            Complete
          </button>
        </div>
      </li>
    `;
  }).join('');

  document.getElementById('active-count').textContent = tasks.length;
  saveState();
}

function renderGraveyard() {
  const container = document.getElementById('graveyard-list');
  const countEl = document.getElementById('graveyard-count');
  
  // Update count
  const count = graveyard.length;
  countEl.textContent = count === 1 ? '1 soul' : `${count} souls`;
  
  // Show/hide graveyard section
  const section = document.getElementById('graveyard-section');
  section.style.display = count > 0 ? 'block' : 'none';
  
  container.innerHTML = graveyard.map(g => {
    const escapedName = escapeHtml(g.name);
    return `
      <li class="grave-card" id="grave-${g.id}">
        <div class="grave-card-header">
          <span class="grave-card-name">${escapedName}</span>
          <span class="grave-card-timer" data-expired-at="${g.expiredAt}">${formatGraveyardTime(g.expiredAt)}</span>
        </div>
        <div class="grave-card-actions">
          <button type="button" class="resurrect-btn" data-grave-id="${g.id}" aria-label="Resurrect ${escapedName}">
            Hold to Resurrect
          </button>
          <button type="button" class="permanent-delete-btn" data-grave-id="${g.id}" aria-label="Permanently delete">
            ×
          </button>
        </div>
      </li>
    `;
  }).join('');
}

function updateTimers() {
  // Check for expired tasks
  checkForExpiredTasks();
  checkGraveyardExpiration();
  
  // Update active task timers
  document.querySelectorAll('.timer-value').forEach(el => {
    const deadline = parseInt(el.dataset.deadline, 10);
    if (!isNaN(deadline)) {
      el.textContent = formatTime(deadline);
    }
  });

  document.querySelectorAll('.progress-fill').forEach(el => {
    const deadline = parseInt(el.dataset.deadline, 10);
    const created = parseInt(el.dataset.created, 10);
    if (!isNaN(deadline) && !isNaN(created)) {
      el.style.width = getProgress(deadline, created) + '%';
    }
  });

  // Update task card states
  tasks.forEach(t => {
    const card = document.getElementById('task-' + t.id);
    if (card) {
      const state = getState(t.deadline);
      card.className = 'task-card ' + state;
      const status = card.querySelector('.task-status');
      if (status) status.textContent = state;
    }
  });

  // Update graveyard timers
  document.querySelectorAll('.grave-card-timer').forEach(el => {
    const expiredAt = parseInt(el.dataset.expiredAt, 10);
    if (!isNaN(expiredAt)) {
      el.textContent = formatGraveyardTime(expiredAt);
    }
  });

  // Update hyperfocus
  if (hfTask) {
    document.getElementById('hf-timer').textContent = formatTime(hfTask.deadline);
    const state = getState(hfTask.deadline);
    const statusEl = document.getElementById('hf-status');
    statusEl.textContent = state;
    statusEl.style.color = STATE_COLORS[state].color;
    statusEl.style.background = STATE_COLORS[state].bg;
    document.getElementById('hf-timer').style.color = STATE_COLORS[state].color;
    
    // Heartbeat haptic in final 60 seconds
    if (state === 'TERMINAL') {
      const remaining = hfTask.deadline - Date.now();
      if (remaining > 0 && remaining <= MS_PER_MINUTE) {
        // Trigger heartbeat every 10 seconds in terminal state
        if (Math.floor(remaining / 10000) !== Math.floor((remaining + 1000) / 10000)) {
          triggerHaptic('heartbeat');
        }
      }
    }
  }
}

function updateStats() {
  document.getElementById('streak').textContent = streak;
  document.getElementById('completed-count').textContent = completedCount;
  document.getElementById('expired-count').textContent = expiredCount;

  const total = completedCount + expiredCount;
  const rate = total > 0 ? Math.round((completedCount / total) * 100) : 0;
  document.getElementById('success-rate').textContent = rate + '%';
}

// ==================== TASK ACTIONS ====================

function completeTask(id) {
  tasks = tasks.filter(t => t.id !== id);
  completedCount++;
  streak++;
  updateStats();
  renderAll();
  showBurst('success');
  triggerHaptic('success');
}

function deleteTask(id) {
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  
  // Manual delete goes straight to graveyard too
  handleTaskExpiration(task);
}

function showBurst(type) {
  const el = document.getElementById(type + '-burst');
  if (!el) return;
  el.classList.add('active');
  setTimeout(() => el.classList.remove('active'), 400);
}

// ==================== MODAL HANDLING ====================

function openModal() {
  document.getElementById('modal').classList.add('active');
  document.getElementById('task-input').focus();
}

function closeModal() {
  document.getElementById('modal').classList.remove('active');
  document.getElementById('task-input').value = '';
  document.getElementById('submit-btn').disabled = true;
}

function addTask() {
  const input = document.getElementById('task-input');
  const name = input.value.trim().slice(0, MAX_TASK_NAME_LENGTH);
  if (!name) return;

  const now = Date.now();
  const newTask = {
    id: now.toString(36) + Math.random().toString(36).slice(2, 6),
    name: name,
    deadline: now + selectedMins * MS_PER_MINUTE,
    created: now
  };

  tasks.push(newTask);
  renderAll();
  closeModal();
  showBurst('success');
  triggerHaptic('success');
}

// ==================== HYPER FOCUS ====================

function enterHyperFocus(id) {
  hfTask = tasks.find(t => t.id === id);
  if (!hfTask) return;

  const state = getState(hfTask.deadline);

  document.getElementById('hf-status').textContent = state;
  document.getElementById('hf-status').style.color = STATE_COLORS[state].color;
  document.getElementById('hf-status').style.background = STATE_COLORS[state].bg;
  document.getElementById('hf-task').textContent = hfTask.name;
  document.getElementById('hf-timer').textContent = formatTime(hfTask.deadline);
  document.getElementById('hf-timer').style.color = STATE_COLORS[state].color;
  document.getElementById('hyperfocus').classList.add('active');
  
  // Request Wake Lock to prevent screen sleep
  requestWakeLock();
}

function exitHyperFocus() {
  document.getElementById('hyperfocus').classList.remove('active');
  
  // Release Wake Lock
  releaseWakeLock();
  
  // Remove wake lock indicator if present
  const indicator = document.querySelector('.wake-lock-indicator');
  if (indicator) indicator.remove();
  
  hfTask = null;
}

function completeHyperFocus() {
  if (hfTask) {
    completeTask(hfTask.id);
    exitHyperFocus();
  }
}

// ==================== TIMER ====================

function startTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
  }
  timerInterval = setInterval(updateTimers, MS_PER_SECOND);
}

// ==================== EVENT LISTENERS ====================

function setupEventListeners() {
  // New task button
  document.getElementById('new-task-btn').addEventListener('click', openModal);

  // Modal close button
  document.getElementById('modal-close').addEventListener('click', closeModal);

  // Submit button
  document.getElementById('submit-btn').addEventListener('click', addTask);

  // Task list event delegation
  document.getElementById('task-list').addEventListener('click', function(e) {
    const target = e.target.closest('button');
    if (!target) return;

    const taskId = target.dataset.taskId;
    if (!taskId) return;

    if (target.classList.contains('focus-btn')) {
      enterHyperFocus(taskId);
    } else if (target.classList.contains('btn-delete')) {
      deleteTask(taskId);
    } else if (target.classList.contains('btn-complete')) {
      completeTask(taskId);
    }
  });

  // Graveyard event delegation
  document.getElementById('graveyard-list').addEventListener('click', function(e) {
    const target = e.target.closest('button');
    if (!target) return;

    const graveId = target.dataset.graveId;
    if (!graveId) return;

    if (target.classList.contains('permanent-delete-btn')) {
      permanentlyDeleteGrave(graveId);
    }
  });

  // Resurrect button hold-to-confirm
  document.getElementById('graveyard-list').addEventListener('mousedown', function(e) {
    const target = e.target.closest('.resurrect-btn');
    if (!target) return;
    
    const graveId = target.dataset.graveId;
    target.classList.add('holding');
    
    resurrectHoldTimers[graveId] = setTimeout(() => {
      resurrectTask(graveId);
      target.classList.remove('holding');
    }, RESURRECT_HOLD_DURATION);
  });

  document.getElementById('graveyard-list').addEventListener('mouseup', function(e) {
    const target = e.target.closest('.resurrect-btn');
    if (!target) return;
    
    const graveId = target.dataset.graveId;
    target.classList.remove('holding');
    
    if (resurrectHoldTimers[graveId]) {
      clearTimeout(resurrectHoldTimers[graveId]);
      delete resurrectHoldTimers[graveId];
    }
  });

  document.getElementById('graveyard-list').addEventListener('mouseleave', function(e) {
    const target = e.target.closest('.resurrect-btn');
    if (!target) return;
    
    const graveId = target.dataset.graveId;
    target.classList.remove('holding');
    
    if (resurrectHoldTimers[graveId]) {
      clearTimeout(resurrectHoldTimers[graveId]);
      delete resurrectHoldTimers[graveId];
    }
  });

  // Touch events for mobile hold-to-resurrect
  document.getElementById('graveyard-list').addEventListener('touchstart', function(e) {
    const target = e.target.closest('.resurrect-btn');
    if (!target) return;
    
    const graveId = target.dataset.graveId;
    target.classList.add('holding');
    
    resurrectHoldTimers[graveId] = setTimeout(() => {
      resurrectTask(graveId);
      target.classList.remove('holding');
    }, RESURRECT_HOLD_DURATION);
  });

  document.getElementById('graveyard-list').addEventListener('touchend', function(e) {
    const target = e.target.closest('.resurrect-btn');
    if (!target) return;
    
    const graveId = target.dataset.graveId;
    target.classList.remove('holding');
    
    if (resurrectHoldTimers[graveId]) {
      clearTimeout(resurrectHoldTimers[graveId]);
      delete resurrectHoldTimers[graveId];
    }
  });

  // Time presets
  document.querySelectorAll('.time-preset').forEach(btn => {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.time-preset').forEach(b => b.classList.remove('selected'));
      this.classList.add('selected');
      selectedMins = parseInt(this.dataset.mins, 10) || 60;
    });
  });

  // Input validation
  document.getElementById('task-input').addEventListener('input', function() {
    document.getElementById('submit-btn').disabled = !this.value.trim();
  });

  // Enter key to submit
  document.getElementById('task-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && this.value.trim()) {
      addTask();
    }
  });

  // Hyperfocus buttons
  document.getElementById('hf-exit-btn').addEventListener('click', exitHyperFocus);
  document.getElementById('hf-complete-btn').addEventListener('click', completeHyperFocus);

  // Keyboard shortcuts
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      if (document.getElementById('hyperfocus').classList.contains('active')) {
        exitHyperFocus();
      } else if (document.getElementById('modal').classList.contains('active')) {
        closeModal();
      }
    }
  });

  // Close modal on overlay click
  document.getElementById('modal').addEventListener('click', function(e) {
    if (e.target === this) {
      closeModal();
    }
  });

  // Settings button
  document.getElementById('settings-btn').addEventListener('click', openSettings);
  
  // Settings close button
  document.getElementById('settings-close').addEventListener('click', closeSettings);
  
  // Settings modal overlay click
  document.getElementById('settings-modal').addEventListener('click', function(e) {
    if (e.target === this) {
      closeSettings();
    }
  });
  
  // Settings toggles
  document.getElementById('setting-sound').addEventListener('change', function() {
    updateSetting('sound', this.checked);
  });
  
  document.getElementById('setting-haptic').addEventListener('change', function() {
    updateSetting('haptic', this.checked);
  });
  
  document.getElementById('setting-graveyard').addEventListener('change', function() {
    updateSetting('graveyard', this.checked);
  });
  
  document.getElementById('setting-default-time').addEventListener('change', function() {
    updateSetting('defaultTime', parseInt(this.value, 10));
  });
  
  // Clear data button
  document.getElementById('clear-data-btn').addEventListener('click', clearAllData);
  
  // Long-press for rapid entry on New Mission button
  const newTaskBtn = document.getElementById('new-task-btn');
  
  newTaskBtn.addEventListener('mousedown', function(e) {
    startLongPress();
  });
  
  newTaskBtn.addEventListener('mouseup', function(e) {
    // If long-press timer completed, quick presets are showing
    if (!document.getElementById('quick-presets').classList.contains('active')) {
      cancelLongPress();
      openModal();
    }
  });
  
  newTaskBtn.addEventListener('mouseleave', function(e) {
    cancelLongPress();
  });
  
  // Touch events for mobile long-press
  newTaskBtn.addEventListener('touchstart', function(e) {
    startLongPress();
  });
  
  newTaskBtn.addEventListener('touchend', function(e) {
    // If quick presets not showing, it was a tap
    if (!document.getElementById('quick-presets').classList.contains('active')) {
      cancelLongPress();
      openModal();
    }
  });
  
  newTaskBtn.addEventListener('touchcancel', function(e) {
    cancelLongPress();
  });
  
  // Quick preset buttons
  document.querySelectorAll('.quick-preset-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      const mins = parseInt(this.dataset.mins, 10);
      addQuickTask(mins);
    });
  });
  
  // Close quick presets on click outside
  document.addEventListener('click', function(e) {
    const presets = document.getElementById('quick-presets');
    const newBtn = document.getElementById('new-task-btn');
    if (presets.classList.contains('active') && 
        !presets.contains(e.target) && 
        e.target !== newBtn) {
      hideQuickPresets();
    }
  });
}

// ==================== FOCUS TRAPPING ====================

function trapFocus(container) {
  const focusableElements = container.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  const firstFocusable = focusableElements[0];
  const lastFocusable = focusableElements[focusableElements.length - 1];

  function handleTabKey(e) {
    if (e.key !== 'Tab') return;

    if (e.shiftKey) {
      if (document.activeElement === firstFocusable) {
        e.preventDefault();
        lastFocusable.focus();
      }
    } else {
      if (document.activeElement === lastFocusable) {
        e.preventDefault();
        firstFocusable.focus();
      }
    }
  }

  container.addEventListener('keydown', handleTabKey);
  return () => container.removeEventListener('keydown', handleTabKey);
}

// Enhanced modal open with focus trapping
const originalOpenModal = openModal;
openModal = function() {
  originalOpenModal();
  const modal = document.getElementById('modal');
  modal._cleanupFocusTrap = trapFocus(modal);
  document.querySelectorAll('main, header').forEach(el => {
    el.setAttribute('aria-hidden', 'true');
  });
};

// Enhanced modal close with focus cleanup
const originalCloseModal = closeModal;
closeModal = function() {
  const modal = document.getElementById('modal');
  if (modal._cleanupFocusTrap) {
    modal._cleanupFocusTrap();
    delete modal._cleanupFocusTrap;
  }
  originalCloseModal();
  document.querySelectorAll('main, header').forEach(el => {
    el.removeAttribute('aria-hidden');
  });
};

// ==================== SERVICE WORKER ====================

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .then((registration) => {
        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              showStorageNotification('New version available! Refresh to update.');
            }
          });
        });
      })
      .catch((error) => {
        console.warn('[App] Service Worker registration failed:', error);
      });
  }
}

// ==================== URL SHORTCUTS ====================

function handleUrlShortcuts() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('action') === 'new') {
    setTimeout(openModal, 100);
    window.history.replaceState({}, '', window.location.pathname);
  }
}

// ==================== INITIALIZATION ====================

function init() {
  loadState();
  renderAll();
  renderGraveyard();
  updateStats();
  setupEventListeners();
  startTimer();
}

// Start the app
init();
registerServiceWorker();
handleUrlShortcuts();