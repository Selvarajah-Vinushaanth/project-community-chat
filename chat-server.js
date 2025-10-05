const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Configure Socket.IO with CORS
const io = socketIo(server, {
  cors: {
    origin: ["http://localhost:3000", "https://song-react-with-firestore.vercel.app"],
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Middleware
app.use(cors({
  origin: ["http://localhost:3000", "https://song-react-with-firestore.vercel.app"],
  credentials: true
}));
app.use(express.json());

// Initialize Firebase Admin using service account
try {
  if (!admin.apps.length) {
    const serviceAccountPath = path.join(__dirname, '..', 'song-writing-assistant-4cd39-firebase-adminsdk-fbsvc-6d40c4e659.json');
    const serviceAccount = require(serviceAccountPath);
    
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: `https://${serviceAccount.project_id}-default-rtdb.firebaseio.com`
    });
    
    console.log('✅ Firebase Admin initialized successfully');
  }
} catch (error) {
  console.error('❌ Firebase Admin initialization error:', error);
  console.error('Please ensure the service account file exists in the root directory');
}

const db = admin.firestore();

// Store active users and their socket IDs
const activeUsers = new Map();
const userRooms = new Map();

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Handle user joining
  socket.on('user:join', async (userData) => {
    try {
      const { userId, userName, userEmail, avatar } = userData;
      
      // Store user info
      activeUsers.set(socket.id, {
        userId,
        userName,
        userEmail,
        avatar,
        socketId: socket.id,
        joinedAt: new Date()
      });

      // Join public hub room
      socket.join('public-hub');
      userRooms.set(socket.id, ['public-hub']);

      // Update user presence in Firebase
      await db.collection('chatPresence').doc(userId).set({
        isOnline: true,
        lastSeen: admin.firestore.FieldValue.serverTimestamp(),
        socketId: socket.id,
        userName,
        userEmail,
        avatar
      });

      // Notify others about user joining
      socket.to('public-hub').emit('user:joined', {
        userId,
        userName,
        userEmail,
        avatar,
        message: `${userName} joined the chat`
      });

      // Send current active users to the new user
      const roomUsers = Array.from(activeUsers.values())
        .filter(user => userRooms.get(user.socketId)?.includes('public-hub'));
      
      socket.emit('users:list', roomUsers);

      console.log(`User ${userName} (${userId}) joined public hub`);
    } catch (error) {
      console.error('Error handling user join:', error);
      socket.emit('error', { message: 'Failed to join chat' });
    }
  });

  // Handle sending messages
  socket.on('message:send', async (messageData) => {
    try {
      const user = activeUsers.get(socket.id);
      if (!user) {
        socket.emit('error', { message: 'User not authenticated' });
        return;
      }

      const { content, type = 'text', roomId = 'public-hub' } = messageData;

      // Create message object
      const message = {
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        content,
        type,
        userId: user.userId,
        userName: user.userName,
        userEmail: user.userEmail,
        avatar: user.avatar,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        roomId,
        likes: [],
        replies: []
      };

      // Save message to Firebase
      const messageRef = await db.collection('chatMessages').add({
        ...message,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: new Date()
      });

      // Add the generated ID
      message.firebaseId = messageRef.id;
      message.timestamp = new Date();

      // Broadcast message to room
      io.to(roomId).emit('message:new', message);

      console.log(`Message sent by ${user.userName} in ${roomId}`);
    } catch (error) {
      console.error('Error sending message:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  // Handle typing indicators
  socket.on('typing:start', (data) => {
    const user = activeUsers.get(socket.id);
    if (user) {
      socket.to(data.roomId || 'public-hub').emit('typing:start', {
        userId: user.userId,
        userName: user.userName
      });
    }
  });

  socket.on('typing:stop', (data) => {
    const user = activeUsers.get(socket.id);
    if (user) {
      socket.to(data.roomId || 'public-hub').emit('typing:stop', {
        userId: user.userId,
        userName: user.userName
      });
    }
  });

  // Handle message reactions
  socket.on('message:like', async (data) => {
    try {
      const user = activeUsers.get(socket.id);
      if (!user) return;

      const { messageId, action } = data; // action: 'like' or 'unlike'
      
      // Update in Firebase
      const messageRef = db.collection('chatMessages').doc(messageId);
      const messageDoc = await messageRef.get();
      
      if (messageDoc.exists) {
        const messageData = messageDoc.data();
        let likes = messageData.likes || [];
        
        if (action === 'like' && !likes.includes(user.userId)) {
          likes.push(user.userId);
        } else if (action === 'unlike') {
          likes = likes.filter(id => id !== user.userId);
        }
        
        await messageRef.update({ likes });
        
        // Broadcast the update
        io.to(messageData.roomId || 'public-hub').emit('message:liked', {
          messageId,
          likes,
          userId: user.userId,
          action
        });
      }
    } catch (error) {
      console.error('Error handling message like:', error);
    }
  });

  // Handle user disconnection
  socket.on('disconnect', async () => {
    try {
      const user = activeUsers.get(socket.id);
      if (user) {
        // Update presence in Firebase
        await db.collection('chatPresence').doc(user.userId).update({
          isOnline: false,
          lastSeen: admin.firestore.FieldValue.serverTimestamp()
        });

        // Notify others about user leaving
        const rooms = userRooms.get(socket.id) || [];
        rooms.forEach(room => {
          socket.to(room).emit('user:left', {
            userId: user.userId,
            userName: user.userName,
            message: `${user.userName} left the chat`
          });
        });

        // Clean up
        activeUsers.delete(socket.id);
        userRooms.delete(socket.id);

        console.log(`User ${user.userName} disconnected`);
      }
    } catch (error) {
      console.error('Error handling disconnect:', error);
    }
  });

  // Handle getting message history
  socket.on('messages:history', async (data) => {
    try {
      const { roomId = 'public-hub', limit = 50, lastMessageId } = data;
      
      // Simplified query to avoid composite index requirement
      // We'll filter by roomId in memory instead of in the query
      let query = db.collection('chatMessages')
        .orderBy('createdAt', 'desc')
        .limit(limit * 2); // Get more documents to account for filtering

      if (lastMessageId) {
        const lastDoc = await db.collection('chatMessages').doc(lastMessageId).get();
        if (lastDoc.exists) {
          query = query.startAfter(lastDoc);
        }
      }

      const snapshot = await query.get();
      const messages = [];
      
      snapshot.forEach(doc => {
        const data = doc.data();
        // Filter by roomId in memory to avoid composite index
        if (data.roomId === roomId) {
          messages.push({
            ...data,
            firebaseId: doc.id,
            timestamp: data.createdAt?.toDate() || new Date()
          });
        }
      });

      // Limit to requested amount and send in chronological order (oldest first)
      const limitedMessages = messages.slice(0, limit).reverse();
      socket.emit('messages:history', limitedMessages);
      
      console.log(`📜 Sent ${limitedMessages.length} messages for room: ${roomId}`);
    } catch (error) {
      console.error('Error fetching message history:', error);
      socket.emit('error', { message: 'Failed to load message history' });
    }
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    activeUsers: activeUsers.size,
    timestamp: new Date().toISOString()
  });
});

// Get active users endpoint
app.get('/api/chat/users', (req, res) => {
  const users = Array.from(activeUsers.values()).map(user => ({
    userId: user.userId,
    userName: user.userName,
    userEmail: user.userEmail,
    avatar: user.avatar,
    joinedAt: user.joinedAt
  }));
  
  res.json({ users, count: users.length });
});

const PORT = process.env.PORT || 5001;

server.listen(PORT, () => {
  console.log(`🚀 Chat server running on port ${PORT}`);
  console.log(`📡 Socket.IO server ready for connections`);
});

module.exports = { app, server, io };