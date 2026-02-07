const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Configure Multer with Cloudinary Storage
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'teacher-images',
    allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
    transformation: [{ width: 800, height: 800, crop: 'limit' }]
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/rateyourteacher', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
})
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => {
    console.error('❌ MongoDB Connection Error:', err.message);
    process.exit(1);
  });

mongoose.connection.on('error', err => {
  console.error('MongoDB error:', err);
});

// Schemas
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  school: { type: mongoose.Schema.Types.ObjectId, ref: 'School' },
  class: { type: mongoose.Schema.Types.ObjectId, ref: 'Class' },
  isSetup: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const SchoolSchema = new mongoose.Schema({
  name: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const ClassSchema = new mongoose.Schema({
  name: { type: String, required: true },
  school: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  createdAt: { type: Date, default: Date.now }
});

const TeacherSchema = new mongoose.Schema({
  name: { type: String, required: true },
  qualifications: { type: String, required: true },
  imageUrl: { type: String, required: true },
  class: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
  school: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  averageRating: { type: Number, default: 0 },
  totalRatings: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const ReviewSchema = new mongoose.Schema({
  teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username: { type: String, required: true },
  text: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const RatingSchema = new mongoose.Schema({
  teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  rating: { type: Number, required: true, min: 1, max: 5 },
  createdAt: { type: Date, default: Date.now }
});

const DiscussionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username: { type: String, required: true },
  message: { type: String, required: true },
  isPinned: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const AdminConfigSchema = new mongoose.Schema({
  secret: { type: String, required: true },
  anonymousReviews: { type: Boolean, default: false },
  hideTeacherImages: { type: Boolean, default: false }
});

// Models
const User = mongoose.model('User', UserSchema);
const School = mongoose.model('School', SchoolSchema);
const Class = mongoose.model('Class', ClassSchema);
const Teacher = mongoose.model('Teacher', TeacherSchema);
const Review = mongoose.model('Review', ReviewSchema);
const Rating = mongoose.model('Rating', RatingSchema);
const Discussion = mongoose.model('Discussion', DiscussionSchema);
const AdminConfig = mongoose.model('AdminConfig', AdminConfigSchema);

// Initialize admin config
async function initializeAdminConfig() {
  const config = await AdminConfig.findOne();
  if (!config) {
    const hashedSecret = await bcrypt.hash('admin', 10);
    await AdminConfig.create({
      secret: hashedSecret,
      anonymousReviews: false,
      hideTeacherImages: false
    });
  }
}
initializeAdminConfig();

// Auth Middleware
const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) throw new Error();
    
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.userId);
    if (!user) throw new Error();
    
    req.user = user;
    req.userId = user._id;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Please authenticate' });
  }
};

// Health Route
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// User Routes
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({
      username,
      password: hashedPassword
    });
    
    const token = jwt.sign({ userId: user._id }, JWT_SECRET);
    res.json({ token, user: { id: user._id, username: user.username, isSetup: user.isSetup } });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign({ userId: user._id }, JWT_SECRET);
    res.json({ 
      token, 
      user: { 
        id: user._id, 
        username: user.username, 
        isSetup: user.isSetup,
        school: user.school,
        class: user.class
      } 
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/setup', auth, async (req, res) => {
  try {
    const { schoolId, classId } = req.body;
    
    const user = await User.findById(req.userId);
    if (user.isSetup) {
      return res.status(400).json({ error: 'Setup already completed' });
    }
    
    user.school = schoolId;
    user.class = classId;
    user.isSetup = true;
    await user.save();
    
    res.json({ message: 'Setup completed successfully' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// School Routes
app.get('/api/schools', async (req, res) => {
  try {
    const schools = await School.find().sort({ name: 1 });
    res.json(schools);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/schools/:schoolId/classes', async (req, res) => {
  try {
    const classes = await Class.find({ school: req.params.schoolId }).sort({ name: 1 });
    res.json(classes);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Teacher Routes
app.get('/api/teachers', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user.isSetup) {
      return res.status(400).json({ error: 'Please complete setup first' });
    }
    
    const config = await AdminConfig.findOne();
    const teachers = await Teacher.find({ class: user.class });
    
    // Apply hide images setting
    const teachersData = teachers.map(teacher => {
      const teacherObj = teacher.toObject();
      if (config && config.hideTeacherImages) {
        teacherObj.imageUrl = '';
      }
      return teacherObj;
    });
    
    res.json(teachersData);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/teachers/:teacherId', auth, async (req, res) => {
  try {
    const teacher = await Teacher.findById(req.params.teacherId);
    if (!teacher) {
      return res.status(404).json({ error: 'Teacher not found' });
    }
    
    const config = await AdminConfig.findOne();
    const teacherObj = teacher.toObject();
    if (config && config.hideTeacherImages) {
      teacherObj.imageUrl = '';
    }
    
    res.json(teacherObj);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Review Routes
app.get('/api/teachers/:teacherId/reviews', auth, async (req, res) => {
  try {
    const config = await AdminConfig.findOne();
    let reviews = await Review.find({ teacher: req.params.teacherId })
      .sort({ createdAt: -1 })
      .limit(50);
    
    // Apply anonymous reviews setting
    if (config && config.anonymousReviews) {
      reviews = reviews.map(review => {
        const reviewObj = review.toObject();
        reviewObj.username = 'Anonymous';
        return reviewObj;
      });
    }
    
    res.json(reviews);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/teachers/:teacherId/my-review', auth, async (req, res) => {
  try {
    const review = await Review.findOne({ 
      teacher: req.params.teacherId, 
      user: req.userId 
    });
    res.json(review);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/teachers/:teacherId/reviews', auth, async (req, res) => {
  try {
    const { text } = req.body;
    const user = await User.findById(req.userId);
    
    const existingReview = await Review.findOne({
      teacher: req.params.teacherId,
      user: req.userId
    });
    
    if (existingReview) {
      return res.status(400).json({ error: 'You have already reviewed this teacher' });
    }
    
    const review = await Review.create({
      teacher: req.params.teacherId,
      user: req.userId,
      username: user.username,
      text
    });
    
    res.json(review);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/reviews/:reviewId', auth, async (req, res) => {
  try {
    const { text } = req.body;
    const review = await Review.findOne({ _id: req.params.reviewId, user: req.userId });
    
    if (!review) {
      return res.status(404).json({ error: 'Review not found' });
    }
    
    review.text = text;
    review.updatedAt = new Date();
    await review.save();
    
    res.json(review);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Rating Routes
app.get('/api/teachers/:teacherId/my-rating', auth, async (req, res) => {
  try {
    const rating = await Rating.findOne({ 
      teacher: req.params.teacherId, 
      user: req.userId 
    });
    res.json(rating);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/teachers/:teacherId/ratings', auth, async (req, res) => {
  try {
    const { rating } = req.body;
    
    let existingRating = await Rating.findOne({
      teacher: req.params.teacherId,
      user: req.userId
    });
    
    if (existingRating) {
      existingRating.rating = rating;
      await existingRating.save();
    } else {
      existingRating = await Rating.create({
        teacher: req.params.teacherId,
        user: req.userId,
        rating
      });
    }
    
    // Update teacher average rating
    const ratings = await Rating.find({ teacher: req.params.teacherId });
    const avgRating = ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length;
    
    await Teacher.findByIdAndUpdate(req.params.teacherId, {
      averageRating: avgRating,
      totalRatings: ratings.length
    });
    
    res.json(existingRating);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Discussion Routes
app.get('/api/discussions', auth, async (req, res) => {
  try {
    const discussions = await Discussion.find()
      .sort({ isPinned: -1, createdAt: -1 })
      .limit(100);
    res.json(discussions);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/discussions', auth, async (req, res) => {
  try {
    const { message } = req.body;
    const user = await User.findById(req.userId);
    
    const discussion = await Discussion.create({
      user: req.userId,
      username: user.username,
      message
    });
    
    res.json(discussion);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Admin Routes
app.post('/api/admin/login', async (req, res) => {
  try {
    const { secret } = req.body;
    const config = await AdminConfig.findOne();
    
    if (!config) {
      return res.status(401).json({ error: 'Invalid secret' });
    }
    
    const isMatch = await bcrypt.compare(secret, config.secret);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid secret' });
    }
    
    const token = jwt.sign({ isAdmin: true }, JWT_SECRET);
    res.json({ token });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

const adminAuth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) throw new Error();
    
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded.isAdmin) throw new Error();
    
    next();
  } catch (error) {
    res.status(401).json({ error: 'Admin authentication required' });
  }
};

// Admin Config Routes
app.get('/api/admin/config', adminAuth, async (req, res) => {
  try {
    const config = await AdminConfig.findOne();
    res.json({
      anonymousReviews: config.anonymousReviews,
      hideTeacherImages: config.hideTeacherImages
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/admin/config', adminAuth, async (req, res) => {
  try {
    const { anonymousReviews, hideTeacherImages } = req.body;
    const config = await AdminConfig.findOne();
    
    if (anonymousReviews !== undefined) {
      config.anonymousReviews = anonymousReviews;
    }
    if (hideTeacherImages !== undefined) {
      config.hideTeacherImages = hideTeacherImages;
    }
    
    await config.save();
    res.json({
      anonymousReviews: config.anonymousReviews,
      hideTeacherImages: config.hideTeacherImages
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Image Upload Route
app.post('/api/admin/upload-image', adminAuth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }
    
    res.json({ 
      imageUrl: req.file.path,
      message: 'Image uploaded successfully'
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Admin School Routes
app.post('/api/admin/schools', adminAuth, async (req, res) => {
  try {
    const { name } = req.body;
    const school = await School.create({ name });
    res.json(school);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/admin/schools/:schoolId', adminAuth, async (req, res) => {
  try {
    await School.findByIdAndDelete(req.params.schoolId);
    await Class.deleteMany({ school: req.params.schoolId });
    await Teacher.deleteMany({ school: req.params.schoolId });
    res.json({ message: 'School deleted successfully' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Admin Class Routes
app.post('/api/admin/classes', adminAuth, async (req, res) => {
  try {
    const { name, schoolId } = req.body;
    const classObj = await Class.create({ name, school: schoolId });
    res.json(classObj);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/admin/classes/:classId', adminAuth, async (req, res) => {
  try {
    await Class.findByIdAndDelete(req.params.classId);
    await Teacher.deleteMany({ class: req.params.classId });
    res.json({ message: 'Class deleted successfully' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Admin Teacher Routes
app.get('/api/admin/teachers', adminAuth, async (req, res) => {
  try {
    const teachers = await Teacher.find()
      .populate('school', 'name')
      .populate('class', 'name')
      .sort({ createdAt: -1 });
    res.json(teachers);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/admin/teachers', adminAuth, async (req, res) => {
  try {
    const { name, qualifications, imageUrl, classId, schoolId } = req.body;
    const teacher = await Teacher.create({
      name,
      qualifications,
      imageUrl,
      class: classId,
      school: schoolId
    });
    res.json(teacher);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/admin/teachers/:teacherId', adminAuth, async (req, res) => {
  try {
    const { name, qualifications, imageUrl } = req.body;
    const teacher = await Teacher.findByIdAndUpdate(
      req.params.teacherId,
      { name, qualifications, imageUrl },
      { new: true }
    );
    res.json(teacher);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/admin/teachers/:teacherId', adminAuth, async (req, res) => {
  try {
    await Teacher.findByIdAndDelete(req.params.teacherId);
    await Review.deleteMany({ teacher: req.params.teacherId });
    await Rating.deleteMany({ teacher: req.params.teacherId });
    res.json({ message: 'Teacher deleted successfully' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Admin Review Routes
app.get('/api/admin/reviews', adminAuth, async (req, res) => {
  try {
    const reviews = await Review.find()
      .populate('teacher', 'name')
      .sort({ createdAt: -1 });
    res.json(reviews);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/admin/reviews/:reviewId', adminAuth, async (req, res) => {
  try {
    await Review.findByIdAndDelete(req.params.reviewId);
    res.json({ message: 'Review deleted successfully' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Admin User Routes
app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const users = await User.find()
      .select('-password')
      .populate('school', 'name')
      .populate('class', 'name')
      .sort({ createdAt: -1 });
    res.json(users);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/admin/users/:userId', adminAuth, async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.userId);
    await Review.deleteMany({ user: req.params.userId });
    await Rating.deleteMany({ user: req.params.userId });
    await Discussion.deleteMany({ user: req.params.userId });
    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/admin/users/:userId/reset-password', adminAuth, async (req, res) => {
  try {
    const { newPassword } = req.body;
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await User.findByIdAndUpdate(req.params.userId, { password: hashedPassword });
    res.json({ message: 'Password reset successfully' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Admin Discussion Routes
app.put('/api/admin/discussions/:discussionId/pin', adminAuth, async (req, res) => {
  try {
    const discussion = await Discussion.findById(req.params.discussionId);
    discussion.isPinned = !discussion.isPinned;
    await discussion.save();
    res.json(discussion);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/admin/discussions/:discussionId', adminAuth, async (req, res) => {
  try {
    await Discussion.findByIdAndDelete(req.params.discussionId);
    res.json({ message: 'Discussion deleted successfully' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
