const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = 3009;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  },
});

// Serve static files from current directory
app.use(express.static(path.resolve(__dirname)));

app.get('/', (req, res) => {
  // Luôn trả index.html, UI sẽ xử lý có/không params
  res.sendFile(path.resolve(__dirname, 'index.html'));
});

// Helpers
const MEMBERS_PATH = path.resolve(__dirname, 'database', 'member.json');
const MEMBERS_DEFAULT_PATH = path.resolve(__dirname, 'database', 'member_default.json');
const CRITERIA_PATH = path.resolve(__dirname, 'database', 'criteria.json');
function readMembers() {
  const raw = fs.readFileSync(MEMBERS_PATH, 'utf8');
  return JSON.parse(raw);
}
function writeMembers(data) {
  fs.writeFileSync(MEMBERS_PATH, JSON.stringify(data, null, 4), 'utf8');
}
function readCriteria() {
  const raw = fs.readFileSync(CRITERIA_PATH, 'utf8');
  return JSON.parse(raw);
}

// API: list members by rule (used to populate group options)
app.get('/api/members', (req, res) => {
  try {
    const rule = String(req.query.rule || '').trim();
    const data = readMembers();
    let list = data.members || [];
    if (rule) list = list.filter(m => m.rule === rule);
    // Only expose minimal fields
    res.json(list.map(m => ({ id: m.id, key: m.key, name: m.name, rule: m.rule })));
  } catch (e) {
    res.status(500).json({ error: 'Failed to read members' });
  }
});

// API: get member detail by key
app.get('/api/member/:key', (req, res) => {
  try {
    const key = String(req.params.key || '').trim();
    if (!key) return res.status(400).json({ error: 'key required' });
    const data = readMembers();
    const member = (data.members || []).find(m => m.key === key);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    res.json({
      id: member.id,
      key: member.key,
      name: member.name || '',
      rule: member.rule,
      score: member.score || 0,
      detail_score: member.detail_score || {},
      avatar: member.avatar || '👤'
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to read member' });
  }
});

// API: get members with score (for admin dashboard)
app.get('/api/admin/members', (req, res) => {
  try {
    const data = readMembers();
    const members = (data.members || []).filter(m => m.rule === 'member');
    const connectedKeys = new Set(Array.from(socketMap.values()));
    const result = members.map(m => ({
      id: m.id,
      key: m.key,
      name: m.name || '',
      score: m.score || 0,
      isOnline: connectedKeys.has(m.key)
    }));
    result.sort((a, b) => (b.score || 0) - (a.score || 0));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'Failed to read members' });
  }
});

// API: get online visitors
app.get('/api/admin/visitors', (req, res) => {
  try {
    const data = readMembers();
    const visitors = (data.members || []).filter(m => m.rule === 'visitor');
    const connectedKeys = new Set(Array.from(socketMap.values()));
    const result = visitors
      .filter(v => connectedKeys.has(v.key))
      .map(v => ({
        id: v.id,
        key: v.key,
        name: v.name || '',
        hasEvaluated: false // TODO: implement later
      }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'Failed to read visitors' });
  }
});

app.use(express.json());

// API: get criteria by evaluation_key
app.get('/api/criteria/:evaluationKey', (req, res) => {
  try {
    const evaluationKey = String(req.params.evaluationKey || '').trim();
    if (!evaluationKey) return res.status(400).json({ error: 'evaluationKey required' });
    const criteria = readCriteria();
    const criteriaList = criteria[evaluationKey] || [];
    const ratingLevels = criteria.ratingLevels || [];
    res.json({ criteria: criteriaList, ratingLevels: ratingLevels });
  } catch (e) {
    res.status(500).json({ error: 'Failed to read criteria' });
  }
});

// API: submit evaluation
app.post('/api/evaluate', (req, res) => {
  try {
    const { evaluatorKey, evaluatorRole, targetKey, scores } = req.body;
    
    if (!evaluatorKey || !evaluatorRole || !targetKey || !scores || !Array.isArray(scores)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const data = readMembers();
    const targetMember = data.members.find(m => m.key === targetKey);
    if (!targetMember) return res.status(404).json({ error: 'Target member not found' });

    // Validate evaluator
    const evaluator = data.members.find(m => m.key === evaluatorKey && m.rule === evaluatorRole);
    if (!evaluator) return res.status(404).json({ error: 'Evaluator not found' });

    // Initialize detail_score if needed
    if (!targetMember.detail_score) targetMember.detail_score = {};
    // Admin evaluations are stored under 'room' to align with finalize rule
    const storageKey = (evaluatorRole === 'admin') ? 'room' : evaluatorKey;
    if (!targetMember.detail_score[storageKey]) {
      targetMember.detail_score[storageKey] = { score: 0, criteria: [] };
    }

    // Update criteria scores
    const detailEntry = targetMember.detail_score[storageKey];
    scores.forEach(({ id, score }) => {
      const existing = detailEntry.criteria.find(c => c.id === id);
      if (existing) {
        existing.score = score;
      } else {
        detailEntry.criteria.push({ id, score });
      }
    });

    // Calculate total score for this evaluator
    const totalScore = scores.reduce((sum, { score }) => sum + (score || 0), 0);
    detailEntry.score = totalScore;

    // Save to file
    writeMembers(data);

    // Emit event to trigger recalculation
    io.emit('evaluation_submitted', { evaluatorKey, targetKey });

    res.json({ ok: true, message: 'Đánh giá đã được lưu' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save evaluation: ' + e.message });
  }
});

// API: finalize evaluation and calculate final scores
app.post('/api/evaluate/finalize', (req, res) => {
  try {
    const data = readMembers();
    const members = data.members.filter(m => m.rule === 'member');
    
    members.forEach(member => {
      let finalScore = 0;
      const detailScore = member.detail_score || {};

      // 1. Admin score (room)
      if (detailScore.room && detailScore.room.score) {
        finalScore += detailScore.room.score;
      }

      // 2. Member average (exclude self) - include score even if 0
      const memberEvaluations = [];
      members.forEach(other => {
        if (other.key !== member.key && detailScore[other.key] && typeof detailScore[other.key].score === 'number') {
          memberEvaluations.push(detailScore[other.key].score);
        }
      });
      if (memberEvaluations.length > 0) {
        const memberAvg = memberEvaluations.reduce((a, b) => a + b, 0) / memberEvaluations.length;
        finalScore += memberAvg;
      }

      // 3. Visitor average - exclude entries where score == 0
      const visitorEvaluations = [];
      const visitors = data.members.filter(m => m.rule === 'visitor');
      visitors.forEach(visitor => {
        if (detailScore[visitor.key] && typeof detailScore[visitor.key].score === 'number' && detailScore[visitor.key].score > 0) {
          visitorEvaluations.push(detailScore[visitor.key].score);
        }
      });
      if (visitorEvaluations.length > 0) {
        const visitorAvg = visitorEvaluations.reduce((a, b) => a + b, 0) / visitorEvaluations.length;
        finalScore += visitorAvg;
      }

      // Update member score
      member.score = Math.round(finalScore * 100) / 100; // Round to 2 decimals
    });

    writeMembers(data);

    // Emit event to all clients to refresh
    io.emit('evaluation_finalized', {});

    res.json({ ok: true, message: 'Đã tính điểm và cập nhật thành công' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to finalize evaluation: ' + e.message });
  }
});

// API: reset data (backup member.json and restore from default)
app.post('/api/admin/reset', (req, res) => {
  try {
    const dbDir = path.resolve(__dirname, 'database');
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    
    // Tìm tên backup file chưa tồn tại
    let backupName = `member_${year}_${month}_${day}_bk.json`;
    let backupPath = path.resolve(dbDir, backupName);
    let counter = 1;
    while (fs.existsSync(backupPath)) {
      backupName = `member_${year}_${month}_${day}_bk${counter}.json`;
      backupPath = path.resolve(dbDir, backupName);
      counter++;
    }

    // Backup: rename member.json to backup file
    if (fs.existsSync(MEMBERS_PATH)) {
      fs.renameSync(MEMBERS_PATH, backupPath);
    }

    // Restore: copy member_default.json to member.json
    if (fs.existsSync(MEMBERS_DEFAULT_PATH)) {
      fs.copyFileSync(MEMBERS_DEFAULT_PATH, MEMBERS_PATH);
    } else {
      return res.status(500).json({ error: 'member_default.json not found' });
    }

    res.json({ ok: true, backupFile: backupName, message: 'Đã làm mới dữ liệu thành công' });
  } catch (e) {
    res.status(500).json({ error: 'Reset failed: ' + e.message });
  }
});

// API: join
// body: { role: 'admin'|'member'|'visitor', groupKey?: string, name?: string }
app.post('/api/join', (req, res) => {
  try {
    const role = String(req.body.role || '').trim();
    const name = (req.body.name || '').toString().trim();
    const groupKey = (req.body.groupKey || '').toString().trim();
    if (!role) return res.status(400).json({ error: 'role required' });

    const data = readMembers();
    const members = data.members || [];

    if (role === 'admin') {
      const admin = members.find(m => m.rule === 'admin');
      if (!admin) return res.status(400).json({ error: 'admin not configured' });
      // Cho phép join admin nhiều lần; chỉ set tên nếu đang trống
      if (!admin.name || admin.name.trim() === '') {
        admin.name = 'Admin';
        writeMembers(data);
      }
      return res.json({ ok: true, key: admin.key, role: 'admin', name: admin.name || 'Admin' });
    }

    if (role === 'member') {
      if (!groupKey) return res.status(400).json({ error: 'groupKey required' });
      if (!name) return res.status(400).json({ error: 'name required' });
      const member = members.find(m => m.rule === 'member' && m.key === groupKey);
      if (!member) return res.status(400).json({ error: 'Nhóm không tồn tại' });
      // Cho phép ghi đè name (không kiểm tra đã có name hay chưa)
      member.name = name;
      writeMembers(data);
      return res.json({ ok: true, key: member.key, role: 'member', name: member.name });
    }

    if (role === 'visitor') {
      if (!name) return res.status(400).json({ error: 'name required' });
      const visitorSlots = members.filter(m => m.rule === 'visitor');
      const slot = visitorSlots.find(v => !v.name || v.name.trim() === '');
      if (!slot) return res.status(409).json({ error: 'Hết slot visitor' });
      slot.name = name;
      writeMembers(data);
      return res.json({ ok: true, key: slot.key, role: 'visitor', name: slot.name });
    }

    return res.status(400).json({ error: 'invalid role' });
  } catch (e) {
    res.status(500).json({ error: 'join failed' });
  }
});

// Socket.IO - Track connections by key
const socketMap = new Map(); // socket.id -> member key

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);
  
  // Client gửi key khi connect
  socket.on('register', (data) => {
    const key = String(data.key || '').trim();
    if (key) {
      socketMap.set(socket.id, key);
      console.log(`Socket ${socket.id} registered as ${key}`);
      // Broadcast to admin about online status change
      io.emit('member_status_change', { key, isOnline: true });
    }
  });
  
  socket.on('disconnect', (reason) => {
    const key = socketMap.get(socket.id);
    if (key) {
      socketMap.delete(socket.id);
      console.log(`Socket ${socket.id} (${key}) disconnected:`, reason);
      // Broadcast to admin about offline status
      io.emit('member_status_change', { key, isOnline: false });
    } else {
      console.log('Socket disconnected:', socket.id, reason);
    }
  });

  // Start evaluation mode (admin only)
  socket.on('start_evaluation', () => {
    const key = socketMap.get(socket.id);
    if (key) {
      const data = readMembers();
      const admin = data.members.find(m => m.key === key && m.rule === 'admin');
      if (admin) {
        // Broadcast to all clients to enter evaluation mode
        io.emit('evaluation_mode_started', {});
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});


