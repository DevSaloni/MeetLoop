import 'dotenv/config';

import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';

import authRoutes from './routes/authRoutes.js';
import teamRoutes from './routes/teamRoutes.js';
import meetingRoutes from './routes/meetingRoutes.js';
import notificationRoutes from './routes/notificationRoutes.js';
import miscRoutes from './routes/miscRoutes.js';
import http from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { connectRedis, getRedisPubSub, isRedisReady } from './config/redis.js';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false, limit: '10mb' }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/teams', teamRoutes);
app.use('/api/meetings', meetingRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/misc', miscRoutes);

// Basic Route
app.get('/', (req, res) => {
  res.send('MeetLoop API is running...');
});

app.get('/health', (req, res) => {
  const mongoOk = mongoose.connection.readyState === 1;
  const redisOk = isRedisReady();
  const ok = mongoOk;
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    mongo: mongoOk ? 'connected' : 'disconnected',
    redis: redisOk ? 'connected' : 'unavailable',
    uptime: Math.round(process.uptime())
  });
});

// Socket.io connection logic
io.on('connection', (socket) => {
  socket.on('join', (userId) => {
    socket.join(userId);
  });

  socket.on('join_meeting', (meetingId) => {
    socket.join(`meeting_${meetingId}`);
  });

  socket.on('leave_meeting', (meetingId) => {
    socket.leave(`meeting_${meetingId}`);
  });

  socket.on('join_team', (teamId) => {
    socket.join(`team_${teamId}`);
  });

  socket.on('leave_team', (teamId) => {
    socket.leave(`team_${teamId}`);
  });

  socket.on('disconnect', () => {
  });
});

// Export io for controllers
export { io };

const start = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const { ready: redisReady } = await connectRedis();
    if (redisReady) {
      const { pub, sub } = getRedisPubSub();
      io.adapter(createAdapter(pub, sub));
      console.log('[Socket.io] Redis adapter enabled (multi-instance safe)');
    } else {
      console.warn('[Socket.io] running without Redis adapter — realtime is single-instance only');
    }

    server.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Startup error:', err);
    process.exit(1);
  }
};

start();
