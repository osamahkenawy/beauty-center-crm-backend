import express from 'express';
import multer from 'multer';
import { authMiddleware } from '../middleware/auth.js';
import { uploadToS3, deleteFromS3, generateS3Key } from '../lib/s3.js';

const router = express.Router();

// Multer setup - memory storage (files go to buffer, then to S3)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
      'application/pdf', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} not allowed`), false);
    }
  },
});

// POST /api/uploads - Upload single file
router.post('/', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file provided' });
    }

    const tenantId = req.tenantId || 0;
    const folder = req.body.folder || 'general';
    const key = generateS3Key(tenantId, folder, req.file.originalname);

    const result = await uploadToS3(req.file.buffer, key, req.file.mimetype);

    res.json({
      success: true,
      message: 'File uploaded successfully',
      data: {
        url: result.url,
        key: result.key,
        originalName: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
      },
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ success: false, message: error.message || 'Upload failed' });
  }
});

// POST /api/uploads/multiple - Upload multiple files
router.post('/multiple', authMiddleware, upload.array('files', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: 'No files provided' });
    }

    const tenantId = req.tenantId || 0;
    const folder = req.body.folder || 'general';
    const results = [];

    for (const file of req.files) {
      const key = generateS3Key(tenantId, folder, file.originalname);
      const result = await uploadToS3(file.buffer, key, file.mimetype);
      results.push({
        url: result.url,
        key: result.key,
        originalName: file.originalname,
        size: file.size,
        mimetype: file.mimetype,
      });
    }

    res.json({ success: true, message: `${results.length} files uploaded`, data: results });
  } catch (error) {
    console.error('Multi-upload error:', error);
    res.status(500).json({ success: false, message: error.message || 'Upload failed' });
  }
});

// DELETE /api/uploads - Delete file by key
router.delete('/', authMiddleware, async (req, res) => {
  try {
    const { key } = req.body;
    if (!key) return res.status(400).json({ success: false, message: 'File key required' });

    await deleteFromS3(key);
    res.json({ success: true, message: 'File deleted' });
  } catch (error) {
    console.error('Delete file error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete file' });
  }
});

export default router;
