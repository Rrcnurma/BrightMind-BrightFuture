const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

// AWS SDK v3
const { DynamoDBClient, CreateTableCommand, ListTablesCommand } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, ScanCommand, DeleteCommand, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { S3Client, CreateBucketCommand, PutObjectCommand, ListBucketsCommand } = require('@aws-sdk/client-s3');

const app = express();
const PORT = 3000;

// ── Config LocalStack ──
const AWS_CONFIG = {
  region: 'us-east-1',
  endpoint: 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  forcePathStyle: true,
};

const dynamoClient = new DynamoDBClient(AWS_CONFIG);
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3Client = new S3Client(AWS_CONFIG);

const TABLE_NAME  = 'pendaftaran_les';
const TABLE_AKUN  = 'akun_siswa';
const BUCKET_NAME = 'foto-siswa';

// Hash password sederhana
function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}

// Generate username dari nama + tanggal lahir
function generateUsername(nama, tglLahir) {
  const bersih = nama.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
  return `${bersih}_${tglLahir}`;
}

// ── Middleware ──
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Multer: simpan file di memory sementara
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('File harus berupa gambar'));
    }
  }
});

// ── Setup: buat tabel DynamoDB & bucket S3 ──
async function setup() {
  try {
    const tables = await dynamoClient.send(new ListTablesCommand({}));

    if (!tables.TableNames.includes(TABLE_NAME)) {
      await dynamoClient.send(new CreateTableCommand({
        TableName: TABLE_NAME,
        KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
        BillingMode: 'PAY_PER_REQUEST',
      }));
      console.log('✅ Tabel DynamoDB dibuat:', TABLE_NAME);
    } else {
      console.log('✅ Tabel DynamoDB sudah ada:', TABLE_NAME);
    }

    if (!tables.TableNames.includes(TABLE_AKUN)) {
      await dynamoClient.send(new CreateTableCommand({
        TableName: TABLE_AKUN,
        KeySchema: [{ AttributeName: 'username', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'username', AttributeType: 'S' }],
        BillingMode: 'PAY_PER_REQUEST',
      }));
      console.log('✅ Tabel akun_siswa dibuat');
    } else {
      console.log('✅ Tabel akun_siswa sudah ada');
    }
  } catch (e) {
    console.error('❌ Error DynamoDB:', e.message);
  }

  try {
    const buckets = await s3Client.send(new ListBucketsCommand({}));
    const exists = buckets.Buckets.some(b => b.Name === BUCKET_NAME);
    if (!exists) {
      await s3Client.send(new CreateBucketCommand({ Bucket: BUCKET_NAME }));
      console.log('✅ Bucket S3 dibuat:', BUCKET_NAME);
    } else {
      console.log('✅ Bucket S3 sudah ada:', BUCKET_NAME);
    }
  } catch (e) {
    console.error('❌ Error S3:', e.message);
  }
}

// ── API: Daftar (POST) ──
app.post('/api/daftar', upload.single('foto_siswa'), async (req, res) => {
  try {
    const id   = uuidv4();
    const data = req.body;
    let fotoUrl = null;

    // Validasi password
    if (!data.password || data.password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password minimal 6 karakter' });
    }

    // Generate username
    const username = generateUsername(data.nama_siswa || '', data.tanggal_lahir || '');

    // Cek username sudah ada?
    const cekAkun = await docClient.send(new GetCommand({ TableName: TABLE_AKUN, Key: { username } }));
    if (cekAkun.Item) {
      return res.status(400).json({ success: false, message: 'Siswa dengan nama dan tanggal lahir ini sudah terdaftar' });
    }

    // Upload foto ke S3 (jika ada)
    if (req.file) {
      const fileName = `${id}-${req.file.originalname}`;
      await s3Client.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: fileName,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      }));
      fotoUrl = `http://localhost:4566/${BUCKET_NAME}/${fileName}`;
    }

    // Simpan data ke DynamoDB
    const item = {
      id,
      nama_siswa: data.nama_siswa || '',
      tempat_lahir: data.tempat_lahir || '',
      tanggal_lahir: data.tanggal_lahir || '',
      jenis_kelamin: data.jenis_kelamin || '',
      jenjang: data.jenjang || '',
      kelas: data.kelas || '',
      nama_sekolah: data.nama_sekolah || '',
      nama_ortu: data.nama_ortu || '',
      hubungan: data.hubungan || '',
      no_hp: data.no_hp || '',
      email: data.email || '',
      alamat: data.alamat || '',
      mapel: Array.isArray(data.mapel) ? data.mapel : [data.mapel].filter(Boolean),
      hari: Array.isArray(data.hari) ? data.hari : [data.hari].filter(Boolean),
      waktu_mulai: data.waktu_mulai || '',
      jenis_les: data.jenis_les || '',
      durasi: data.durasi || '',
      info_dari: data.info_dari || '',
      foto_url: fotoUrl,
      tanggal_daftar: new Date().toISOString(),
      status: 'Menunggu Konfirmasi',
      username,
    };
    await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));

    // Simpan akun ke tabel akun_siswa
    await docClient.send(new PutCommand({
      TableName: TABLE_AKUN,
      Item: {
        username,
        password_hash: hashPassword(data.password),
        siswa_id: id,
        nama: data.nama_siswa,
      }
    }));

    res.json({ success: true, message: 'Pendaftaran berhasil!', id, username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Gagal mendaftar: ' + err.message });
  }
});

// ── API: Login (POST) ──
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username dan password wajib diisi' });
    }

    const result = await docClient.send(new GetCommand({
      TableName: TABLE_AKUN,
      Key: { username: username.toLowerCase() }
    }));

    if (!result.Item) {
      return res.json({ success: false, message: 'Username tidak ditemukan' });
    }

    if (result.Item.password_hash !== hashPassword(password)) {
      return res.json({ success: false, message: 'Password salah' });
    }

    // Ambil data siswa lengkap
    const siswaResult = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { id: result.Item.siswa_id }
    }));

    res.json({
      success: true,
      siswa: {
        username,
        nama: result.Item.nama,
        id: result.Item.siswa_id,
        ...siswaResult.Item
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Gagal login: ' + err.message });
  }
});

// ── API: Lihat Semua Siswa (GET) ──
app.get('/api/siswa', async (req, res) => {
  try {
    const result = await docClient.send(new ScanCommand({ TableName: TABLE_NAME }));
    res.json({ success: true, data: result.Items || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── API: Hapus Siswa (DELETE) ──
app.delete('/api/siswa/:id', async (req, res) => {
  try {
    await docClient.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { id: req.params.id } }));
    res.json({ success: true, message: 'Data berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── API: Jadwal (GET) ──
app.get('/api/jadwal', async (req, res) => {
  try {
    const result = await docClient.send(new ScanCommand({ TableName: TABLE_NAME }));
    const jadwal = (result.Items || []).map(s => ({
      id: s.id,
      nama: s.nama_siswa,
      jenjang: s.jenjang,
      kelas: s.kelas,
      mapel: s.mapel,
      hari: s.hari,
      waktu: s.waktu_mulai,
      jenis: s.jenis_les,
      status: s.status
    }));
    res.json({ success: true, data: jadwal });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── API: Update Status Siswa (PATCH) ──
app.patch('/api/siswa/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { id: req.params.id },
      UpdateExpression: 'SET #s = :s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': status },
    }));
    res.json({ success: true, message: 'Status berhasil diperbarui' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Jalankan server ──
setup().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀 Server BrightMind BrightFuture berjalan!`);
    console.log(`📌 Buka di browser  : http://localhost:${PORT}`);
    console.log(`🔐 Login            : http://localhost:${PORT}/login.html`);
    console.log(`📋 Daftar siswa     : http://localhost:${PORT}/daftar-siswa.html`);
    console.log(`📅 Jadwal           : http://localhost:${PORT}/jadwal.html\n`);
  });
});
