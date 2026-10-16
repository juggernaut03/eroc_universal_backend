const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

let sharp;
try {
  // eslint-disable-next-line global-require
  sharp = require('sharp');
} catch {
  sharp = null;
}

const UPLOAD_ROOT = process.env.UPLOAD_ROOT || path.join(__dirname, '..', 'uploads');
// Public base URL for UPLOAD_ROOT. Must be set in production (nginx serves the
// folder); without it, links fall back to this API's own /media route.
const MEDIA_PUBLIC_URL = (
  process.env.MEDIA_PUBLIC_URL ||
  `${(process.env.PUBLIC_API_BASE_URL || `http://localhost:${process.env.PORT || 5008}`).replace(/\/$/, '')}/media`
).replace(/\/$/, '');
const MAX_IMAGE_WIDTH = parseInt(process.env.MEDIA_MAX_WIDTH || '1600', 10);

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed!'), false);
    }
    cb(null, true);
  },
});

const sanitizeFolder = (folder = 'ecommerce') => {
  const cleaned = String(folder)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]/g, '')
    .replace(/^\/+|\/+$/g, '');

  return cleaned || 'ecommerce';
};

const ensureDir = async (dirPath) => {
  await fs.promises.mkdir(dirPath, { recursive: true });
};

const buildPublicUrl = (relativePath) => `${MEDIA_PUBLIC_URL}/${relativePath.replace(/\\/g, '/')}`;

const optimizeImage = async (buffer, mimetype) => {
  if (!sharp) {
    const ext = mimetype === 'image/png' ? 'png' : 'jpg';
    return {
      buffer,
      format: ext,
      width: null,
      height: null,
    };
  }

  const pipeline = sharp(buffer, { failOn: 'none' }).rotate().resize({
    width: MAX_IMAGE_WIDTH,
    withoutEnlargement: true,
  });

  if (mimetype === 'image/png') {
    const output = await pipeline.png({ compressionLevel: 8 }).toBuffer({ resolveWithObject: true });
    return {
      buffer: output.data,
      format: 'png',
      width: output.info.width,
      height: output.info.height,
    };
  }

  const output = await pipeline.jpeg({ quality: 82, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  return {
    buffer: output.data,
    format: 'jpg',
    width: output.info.width,
    height: output.info.height,
  };
};

const saveUploadedImage = async (file, folder = 'ecommerce') => {
  const safeFolder = sanitizeFolder(folder);
  const targetDir = path.join(UPLOAD_ROOT, safeFolder);
  await ensureDir(targetDir);

  const optimized = await optimizeImage(file.buffer, file.mimetype);
  const filename = `${crypto.randomUUID()}.${optimized.format}`;
  const absolutePath = path.join(targetDir, filename);
  const relativePath = path.posix.join(safeFolder, filename);

  await fs.promises.writeFile(absolutePath, optimized.buffer);

  return {
    url: buildPublicUrl(relativePath),
    public_id: relativePath,
    format: optimized.format,
    width: optimized.width,
    height: optimized.height,
  };
};

const deleteImage = async (publicIdOrUrl) => {
  try {
    let relativePath = publicIdOrUrl;

    if (publicIdOrUrl.startsWith('http')) {
      const prefix = `${MEDIA_PUBLIC_URL}/`;
      if (!publicIdOrUrl.startsWith(prefix)) {
        return false;
      }
      relativePath = publicIdOrUrl.slice(prefix.length);
    }

    const absolutePath = path.join(UPLOAD_ROOT, relativePath);
    await fs.promises.unlink(absolutePath);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Error deleting local image:', error);
    }
    return false;
  }
};

const extractPublicId = (url) => {
  try {
    const prefix = `${MEDIA_PUBLIC_URL}/`;
    if (url.startsWith(prefix)) {
      return url.slice(prefix.length);
    }
    return null;
  } catch {
    return null;
  }
};

module.exports = {
  upload,
  saveUploadedImage,
  deleteImage,
  extractPublicId,
  UPLOAD_ROOT,
  MEDIA_PUBLIC_URL,
};
