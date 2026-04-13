const ExcelJS = require("exceljs");
const { Op } = require("sequelize");
const { 
  sequelize, 
  RankDatabase, 
  TrxPilihanProgramStudi, 
  RefProgramStudi,
  RefPerguruanTinggi,
  TrxBeasiswa // <-- IMPORT DITAMBAHKAN DI SINI
} = require("../../../models");
const { successResponse, errorResponse, failResponse } = require("../../../common/response");

// Setup relasi untuk keperluan JOIN pencarian dan filter
RankDatabase.belongsTo(RefPerguruanTinggi, { foreignKey: "id_pt", targetKey: "id_pt" });
RankDatabase.belongsTo(RefProgramStudi, { foreignKey: "id_prodi", targetKey: "id_prodi" });
RankDatabase.belongsTo(TrxBeasiswa, { foreignKey: "id_trx_beasiswa", targetKey: "id_trx_beasiswa" }); // <-- RELASI DITAMBAHKAN DI SINI

exports.uploadDataRanking = async (req, res) => {
  try {
    if (!req.file) {
      return failResponse(res, "File Excel tidak ditemukan");
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const worksheet = workbook.worksheets[0];

    if (!worksheet) {
      return failResponse(res, "Sheet tidak ditemukan di dalam file Excel");
    }

    const rawData = [];
    const kodeList = [];

    // 1. Baca data dari Excel (Kolom 1 sekarang adalah Kode Pendaftaran)
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1) {
        const kode = row.getCell(1).value?.toString().trim();
        if (kode) {
          kodeList.push(kode);
          rawData.push({
            kode_pendaftaran: kode,
            nama: row.getCell(2).value?.toString().trim(),
            nilai_akhir: parseFloat(row.getCell(3).value) || 0,
            kluster: row.getCell(4).value?.toString().trim(),
          });
        }
      }
    });

    if (rawData.length === 0) {
      return failResponse(res, "Tidak ada data valid untuk diimport");
    }

    // 2. Cari id_trx_beasiswa berdasarkan kode_pendaftaran yang ada di Excel
    const beasiswaData = await TrxBeasiswa.findAll({
      where: { kode_pendaftaran: { [Op.in]: kodeList } },
      attributes: ['id_trx_beasiswa', 'kode_pendaftaran'],
      raw: true
    });

    // 3. Buat kamus (mapping) untuk mempercepat pencarian ID
    const mapKodeToId = {};
    beasiswaData.forEach(b => {
      mapKodeToId[b.kode_pendaftaran] = b.id_trx_beasiswa;
    });

    // 4. Siapkan data yang akan diinsert ke RankDatabase menggunakan ID asli
    const dataToInsert = [];
    rawData.forEach(item => {
      const idTrx = mapKodeToId[item.kode_pendaftaran];
      if (idTrx) { // Hanya proses jika kode pendaftaran ditemukan di database
        dataToInsert.push({
          id_trx_beasiswa: idTrx,
          nama: item.nama,
          nilai_akhir: item.nilai_akhir,
          kluster: item.kluster,
          status_mundur: "N",
          timestamp: new Date()
        });
      }
    });

    if (dataToInsert.length === 0) {
      return failResponse(res, "Kode Pendaftaran dari Excel tidak ada yang cocok dengan Database.");
    }

    await RankDatabase.bulkCreate(dataToInsert);

    return successResponse(res, `Berhasil mengupload ${dataToInsert.length} data untuk dirangking`);
  } catch (error) {
    console.error(error);
    return errorResponse(res, "Gagal mengupload file Excel");
  }
};

exports.prosesPerangkingan = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    await RankDatabase.update(
      { id_pt: null, id_prodi: null },
      { where: {}, transaction }
    );

    const referensiProdi = await RefProgramStudi.findAll({ transaction });
    
    const sisaKuota = {};
    referensiProdi.forEach((prodi) => {
      sisaKuota[`${prodi.id_pt}-${prodi.id_prodi}`] = prodi.kuota;
    });

   const kandidat = await RankDatabase.findAll({
      where: { status_mundur: "N" },
      order: [
        // Ganti baris ini agar kebal terhadap huruf kecil/besar dan spasi
        [sequelize.literal(`CASE WHEN LOWER(TRIM(kluster)) = 'afirmasi' THEN 1 ELSE 2 END`), "ASC"],
        ["nilai_akhir", "DESC"]
      ],
      transaction
    });

    const kandidatIds = kandidat.map(k => k.id_trx_beasiswa);
    const semuaPilihan = await TrxPilihanProgramStudi.findAll({
      where: { id_trx_beasiswa: { [Op.in]: kandidatIds } },
      order: [["id", "ASC"]],
      transaction
    });

    const mapPilihan = {};
    semuaPilihan.forEach(p => {
      if (!mapPilihan[p.id_trx_beasiswa]) {
        mapPilihan[p.id_trx_beasiswa] = [];
      }
      mapPilihan[p.id_trx_beasiswa].push(p);
    });

    let jumlahBerhasil = 0;
    const kandidatToUpdate = [];

    for (let peserta of kandidat) {
      const pilihanList = mapPilihan[peserta.id_trx_beasiswa] || [];

      for (let pilihan of pilihanList) {
        const keyKuota = `${pilihan.id_pt}-${pilihan.id_prodi}`;
        
        if (sisaKuota[keyKuota] && sisaKuota[keyKuota] > 0) {
          peserta.id_pt = pilihan.id_pt;
          peserta.id_prodi = pilihan.id_prodi;
          
          kandidatToUpdate.push({
            id: peserta.id,
            id_pt: pilihan.id_pt,
            id_prodi: pilihan.id_prodi
          });
          
          sisaKuota[keyKuota] -= 1;
          jumlahBerhasil++;
          break; 
        }
      }
    }

    if (kandidatToUpdate.length > 0) {
      await RankDatabase.bulkCreate(kandidatToUpdate, {
        updateOnDuplicate: ["id_pt", "id_prodi"],
        transaction
      });
    }

    await transaction.commit();
    return successResponse(res, `Proses perangkingan selesai. ${jumlahBerhasil} kandidat berhasil dialokasikan.`);
  } catch (error) {
    await transaction.rollback();
    console.error(error);
    return errorResponse(res, "Terjadi kesalahan saat proses perangkingan");
  }
};

exports.getHasilRanking = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";
    const filterPt = req.query.pt || "";
    const filterProdi = req.query.prodi || "";
    const offset = (page - 1) * limit;

    const whereClause = {
      id_pt: { [Op.ne]: null },
      id_prodi: { [Op.ne]: null }
    };

    if (search) {
      whereClause[Op.or] = [
        { nama: { [Op.like]: `%${search}%` } },
        { '$TrxBeasiswa.kode_pendaftaran$': { [Op.like]: `%${search}%` } }, // <-- Cari berdasar kode
        { '$RefPerguruanTinggi.nama_pt$': { [Op.like]: `%${search}%` } },
        { '$RefProgramStudi.nama_prodi$': { [Op.like]: `%${search}%` } }
      ];
    }

    const includeOptions = [
      { model: TrxBeasiswa, attributes: ['kode_pendaftaran'], required: false }
    ];

    if (filterPt || search) {
      includeOptions.push({
        model: RefPerguruanTinggi,
        attributes: ['nama_pt'],
        where: filterPt ? { nama_pt: { [Op.like]: `%${filterPt}%` } } : undefined,
        required: true
      });
    } else {
      includeOptions.push({ model: RefPerguruanTinggi, attributes: ['nama_pt'] });
    }

    if (filterProdi || search) {
      includeOptions.push({
        model: RefProgramStudi,
        attributes: ['nama_prodi'],
        where: filterProdi ? { nama_prodi: { [Op.like]: `%${filterProdi}%` } } : undefined,
        required: true
      });
    } else {
      includeOptions.push({ model: RefProgramStudi, attributes: ['nama_prodi'] });
    }

    const { count, rows } = await RankDatabase.findAndCountAll({
      where: whereClause,
      include: includeOptions,
      limit: limit,
      offset: offset,
      subQuery: false,
      order: [
        [sequelize.literal(`CASE WHEN kluster = 'Afirmasi' THEN 1 ELSE 2 END`), "ASC"],
        ["nilai_akhir", "DESC"]
      ]
    });

    const formattedData = rows.map(row => ({
      ...row.toJSON(),
      kode_pendaftaran: row.TrxBeasiswa ? row.TrxBeasiswa.kode_pendaftaran : "-",
      nama_pt: row.RefPerguruanTinggi ? row.RefPerguruanTinggi.nama_pt : "-",
      nama_prodi: row.RefProgramStudi ? row.RefProgramStudi.nama_prodi : "-"
    }));

    return successResponse(res, "Berhasil memuat hasil perangkingan", {
      data: formattedData,
      totalData: count,
      currentPage: page,
      totalPages: Math.ceil(count / limit)
    });
  } catch (error) {
    console.error(error);
    return errorResponse(res, "Gagal memuat hasil perangkingan");
  }
};

exports.downloadHasilRankingExcel = async (req, res) => {
  try {
    const search = req.query.search || "";
    const filterPt = req.query.pt || "";
    const filterProdi = req.query.prodi || "";

    const whereClause = {
      id_pt: { [Op.ne]: null },
      id_prodi: { [Op.ne]: null }
    };

    if (search) {
      whereClause[Op.or] = [
        { nama: { [Op.like]: `%${search}%` } },
        { '$TrxBeasiswa.kode_pendaftaran$': { [Op.like]: `%${search}%` } }, // <-- Cari berdasar kode
        { '$RefPerguruanTinggi.nama_pt$': { [Op.like]: `%${search}%` } },
        { '$RefProgramStudi.nama_prodi$': { [Op.like]: `%${search}%` } }
      ];
    }

    const includeOptions = [
      { model: TrxBeasiswa, attributes: ['kode_pendaftaran'], required: false }
    ];

    if (filterPt || search) {
      includeOptions.push({
        model: RefPerguruanTinggi,
        attributes: ['nama_pt'],
        where: filterPt ? { nama_pt: { [Op.like]: `%${filterPt}%` } } : undefined,
        required: true
      });
    } else {
      includeOptions.push({ model: RefPerguruanTinggi, attributes: ['nama_pt'] });
    }

    if (filterProdi || search) {
      includeOptions.push({
        model: RefProgramStudi,
        attributes: ['nama_prodi'],
        where: filterProdi ? { nama_prodi: { [Op.like]: `%${filterProdi}%` } } : undefined,
        required: true
      });
    } else {
      includeOptions.push({ model: RefProgramStudi, attributes: ['nama_prodi'] });
    }

    const hasil = await RankDatabase.findAll({
      where: whereClause,
      include: includeOptions,
      subQuery: false,
      order: [
        [sequelize.literal(`CASE WHEN kluster = 'Afirmasi' THEN 1 ELSE 2 END`), "ASC"],
        ["nilai_akhir", "DESC"]
      ]
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Hasil Ranking");

    worksheet.columns = [
      { header: "No", key: "no", width: 5 },
      { header: "Kode Pendaftaran", key: "kode_pendaftaran", width: 25 }, // <-- Header Diubah
      { header: "Nama", key: "nama", width: 30 },
      { header: "Nilai Akhir", key: "nilai", width: 15 },
      { header: "Kluster", key: "kluster", width: 15 },
      { header: "PT Final", key: "pt", width: 35 },
      { header: "Prodi Final", key: "prodi", width: 35 },
    ];

    hasil.forEach((row, index) => {
      worksheet.addRow({
        no: index + 1,
        kode_pendaftaran: row.TrxBeasiswa ? row.TrxBeasiswa.kode_pendaftaran : "-", // <-- Value Diubah
        nama: row.nama,
        nilai: row.nilai_akhir,
        kluster: row.kluster,
        pt: row.RefPerguruanTinggi ? row.RefPerguruanTinggi.nama_pt : "-",
        prodi: row.RefProgramStudi ? row.RefProgramStudi.nama_prodi : "-"
      });
    });

    worksheet.getRow(1).font = { bold: true };

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=hasil_perangkingan.xlsx"
    );

    await workbook.xlsx.write(res);
    res.status(200).end();
  } catch (error) {
    console.error(error);
    return errorResponse(res, "Gagal mendownload file Excel");
  }
};

exports.resetDataRanking = async (req, res) => {
  try {
    await RankDatabase.destroy({ where: {} });
    return successResponse(res, "Data master perangkingan berhasil dihapus/direset");
  } catch (error) {
    console.error(error);
    return errorResponse(res, "Gagal mereset data perangkingan");
  }
};

exports.getFilterOptions = async (req, res) => {
  try {
    const pts = await RefPerguruanTinggi.findAll({
      attributes: ['id_pt', 'nama_pt'],
      order: [['nama_pt', 'ASC']]
    });
    const prodis = await RefProgramStudi.findAll({
      attributes: ['id_prodi', 'nama_prodi', 'id_pt'],
      order: [['nama_prodi', 'ASC']]
    });

    return successResponse(res, "Berhasil memuat opsi filter", { pts, prodis });
  } catch (error) {
    console.error("Error getFilterOptions:", error);
    return errorResponse(res, "Gagal memuat opsi filter");
  }
};

exports.clearHasilRanking = async (req, res) => {
  try {
    await RankDatabase.update(
      { id_pt: null, id_prodi: null },
      { where: {} }
    );
    return successResponse(res, "Hasil perangkingan berhasil dibersihkan. Data siap dirangking ulang.");
  } catch (error) {
    console.error("Error clearHasilRanking:", error);
    return errorResponse(res, "Gagal membersihkan hasil perangkingan");
  }
};


exports.getAllDatabaseUpload = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";
    const offset = (page - 1) * limit;

    const whereClause = {};

    if (search) {
      whereClause[Op.or] = [
        { nama: { [Op.like]: `%${search}%` } },
        { '$TrxBeasiswa.kode_pendaftaran$': { [Op.like]: `%${search}%` } }, // <-- Cari berdasar kode
        { '$RefPerguruanTinggi.nama_pt$': { [Op.like]: `%${search}%` } },
        { '$RefProgramStudi.nama_prodi$': { [Op.like]: `%${search}%` } }
      ];
    }

    const { count, rows } = await RankDatabase.findAndCountAll({
      where: whereClause,
      include: [
        { model: RefPerguruanTinggi, attributes: ['nama_pt'], required: false },
        { model: RefProgramStudi, attributes: ['nama_prodi'], required: false },
        { model: TrxBeasiswa, attributes: ['kode_pendaftaran'], required: false }
      ],
      limit: limit,
      offset: offset,
      subQuery: false,
      order: [
        [sequelize.literal(`CASE WHEN kluster = 'Afirmasi' THEN 1 ELSE 2 END`), "ASC"],
        ["nilai_akhir", "DESC"]
      ]
    });

    const formattedData = rows.map(row => ({
      ...row.toJSON(),
      kode_pendaftaran: row.TrxBeasiswa ? row.TrxBeasiswa.kode_pendaftaran : "-",
      nama_pt: row.RefPerguruanTinggi ? row.RefPerguruanTinggi.nama_pt : null,
      nama_prodi: row.RefProgramStudi ? row.RefProgramStudi.nama_prodi : null
    }));

    return successResponse(res, "Berhasil memuat semua data upload", {
      data: formattedData,
      totalData: count,
      currentPage: page,
      totalPages: Math.ceil(count / limit)
    });
  } catch (error) {
    console.error("Error getAllDatabaseUpload:", error);
    return errorResponse(res, "Gagal memuat data database upload");
  }
};

exports.updateStatusMundur = async (req, res) => {
  try {
    const { id_trx } = req.params; 
    const { status_mundur } = req.body; 

    const peserta = await RankDatabase.findOne({ 
      where: { id_trx_beasiswa: id_trx } 
    });

    if (!peserta) {
      return failResponse(res, "Data peserta tidak ditemukan");
    }

    peserta.status_mundur = status_mundur;
    
    if (status_mundur === "Y") {
      peserta.id_pt = null;
      peserta.id_prodi = null;
    }

    await peserta.save();

    const pesan = status_mundur === "Y" ? "berhasil ditandai sebagai Mengundurkan Diri" : "berhasil dikembalikan statusnya";
    return successResponse(res, `Peserta ${peserta.nama} ${pesan}. Silakan lakukan Proses Perangkingan ulang agar kuota digantikan oleh cadangan.`);
  } catch (error) {
    console.error("Error updateStatusMundur:", error);
    return errorResponse(res, "Gagal mengubah status mundur peserta");
  }
};


exports.getCadanganRanking = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";
    const offset = (page - 1) * limit;

    // Filter: Belum ada PT/Prodi (null) dan TIDAK mundur
    const whereClause = {
      id_pt: { [Op.is]: null },
      id_prodi: { [Op.is]: null },
      status_mundur: "N" 
    };

    if (search) {
      whereClause[Op.or] = [
        { nama: { [Op.like]: `%${search}%` } },
        { '$TrxBeasiswa.kode_pendaftaran$': { [Op.like]: `%${search}%` } }
      ];
    }

    const { count, rows } = await RankDatabase.findAndCountAll({
      where: whereClause,
      include: [
        { model: TrxBeasiswa, attributes: ['kode_pendaftaran'], required: false }
      ],
      limit: limit,
      offset: offset,
      order: [
        [sequelize.literal(`CASE WHEN kluster = 'Afirmasi' THEN 1 ELSE 2 END`), "ASC"],
        ["nilai_akhir", "DESC"]
      ]
    });

    const formattedData = rows.map(row => ({
      ...row.toJSON(),
      kode_pendaftaran: row.TrxBeasiswa ? row.TrxBeasiswa.kode_pendaftaran : "-",
    }));

    return successResponse(res, "Berhasil memuat data cadangan", {
      data: formattedData,
      totalData: count,
      currentPage: page,
      totalPages: Math.ceil(count / limit)
    });
  } catch (error) {
    console.error("Error getCadanganRanking:", error);
    return errorResponse(res, "Gagal memuat data cadangan");
  }
};

exports.getSisaKuota = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";
    const offset = (page - 1) * limit;

    // Pastikan relasi sudah diset agar bisa search berdasarkan nama PT
    RefProgramStudi.belongsTo(RefPerguruanTinggi, { foreignKey: 'id_pt', targetKey: 'id_pt' });

    const whereClause = {};
    if (search) {
      whereClause[Op.or] = [
        { nama_prodi: { [Op.like]: `%${search}%` } },
        { '$RefPerguruanTinggi.nama_pt$': { [Op.like]: `%${search}%` } }
      ];
    }

    // 1. Ambil data master kuota dari RefProgramStudi
    const { count, rows } = await RefProgramStudi.findAndCountAll({
      where: whereClause,
      include: [{
        model: RefPerguruanTinggi,
        attributes: ['nama_pt']
      }],
      limit: limit,
      offset: offset,
      order: [
        [RefPerguruanTinggi, 'nama_pt', 'ASC'],
        ['nama_prodi', 'ASC']
      ]
    });

    // 2. Hitung jumlah kursi terpakai dari RankDatabase yang id_pt dan id_prodi-nya terisi
    const terpakaiData = await RankDatabase.findAll({
      attributes: [
        'id_pt',
        'id_prodi',
        [sequelize.fn('COUNT', sequelize.col('id')), 'total_terpakai']
      ],
      where: {
        id_pt: { [Op.ne]: null },
        id_prodi: { [Op.ne]: null }
      },
      group: ['id_pt', 'id_prodi']
    });

    // 3. Ubah hasil agregasi hitungan menjadi Dictionary/Object agar aksesnya instan
    const mapTerpakai = {};
    terpakaiData.forEach(item => {
      const pt = item.id_pt;
      const prodi = item.id_prodi;
      const total = item.get('total_terpakai');
      mapTerpakai[`${pt}-${prodi}`] = parseInt(total, 10);
    });

    // 4. Format hasil gabungan (Kuota Master - Terpakai = Sisa)
    const formattedData = rows.map(row => {
      const ptId = row.id_pt;
      const prodiId = row.id_prodi;
      const kuotaMaster = row.kuota || 0;
      const terpakai = mapTerpakai[`${ptId}-${prodiId}`] || 0;
      const sisa = kuotaMaster - terpakai;

      return {
        id_pt: ptId,
        id_prodi: prodiId,
        nama_pt: row.RefPerguruanTinggi ? row.RefPerguruanTinggi.nama_pt : '-',
        nama_prodi: row.nama_prodi,
        kuota_total: kuotaMaster,
        kuota_terpakai: terpakai,
        sisa_kuota: sisa
      };
    });

    return successResponse(res, "Berhasil memuat data kuota program studi", {
      data: formattedData,
      totalData: count,
      currentPage: page,
      totalPages: Math.ceil(count / limit)
    });

  } catch (error) {
    console.error("Error getSisaKuota:", error);
    return errorResponse(res, "Gagal memuat data kuota program studi");
  }
};

exports.getDashboardStats = async (req, res) => {
  try {
    // 1. Data Mentah (Seluruh Data yang diupload)
    const totalDataMentah = await RankDatabase.count();
    const totalAfirmasi = await RankDatabase.count({ where: { kluster: 'Afirmasi' } });
    const totalReguler = await RankDatabase.count({ where: { kluster: 'Reguler' } });

    // 2. Data Hasil Proses (Yang sudah mendapat PT & Prodi)
    const totalProses = await RankDatabase.count({
      where: { id_pt: { [Op.ne]: null }, id_prodi: { [Op.ne]: null } }
    });
    const totalProsesAfirmasi = await RankDatabase.count({
      where: { id_pt: { [Op.ne]: null }, id_prodi: { [Op.ne]: null }, kluster: 'Afirmasi' }
    });
    const totalProsesReguler = await RankDatabase.count({
      where: { id_pt: { [Op.ne]: null }, id_prodi: { [Op.ne]: null }, kluster: 'Reguler' }
    });

    // 3. Data Mundur
    const totalMundur = await RankDatabase.count({ where: { status_mundur: 'Y' } });

    return successResponse(res, "Berhasil memuat statistik dashboard", {
      data_mentah: {
        total: totalDataMentah,
        afirmasi: totalAfirmasi,
        reguler: totalReguler
      },
      data_proses: {
        total: totalProses,
        afirmasi: totalProsesAfirmasi,
        reguler: totalProsesReguler,
        mundur: totalMundur
      }
    });
  } catch (error) {
    console.error("Error getDashboardStats:", error);
    return errorResponse(res, "Gagal memuat data statistik dashboard");
  }
};


// ==========================================
// Download Template Excel untuk Upload
// ==========================================
exports.downloadTemplateRanking = async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Template Upload Ranking");

    // Definisi Kolom
    worksheet.columns = [
      { header: "Kode Pendaftaran", key: "kode", width: 25 },
      { header: "Nama Lengkap", key: "nama", width: 35 },
      { header: "Nilai Akhir", key: "nilai", width: 15 },
      { header: "Kluster", key: "kluster", width: 20 },
    ];

    // Tambahkan 1 baris contoh (contoh cara pengisian)
    worksheet.addRow({
      kode: "2601000001",
      nama: "Contoh Nama Peserta",
      nilai: 85.50,
      kluster: "Reguler" // atau "Afirmasi"
    });

    // Beri catatan agar baris pertama tidak dihapus
    worksheet.addRow(["", "", "", ""]); // baris kosong jarak
    const noteRow = worksheet.addRow(["CATATAN: Hapus baris 2 (contoh data) sebelum upload. Jangan ubah urutan header di baris 1."]);
    worksheet.mergeCells(`A${noteRow.number}:D${noteRow.number}`);
    noteRow.font = { italic: true, color: { argb: "FFFF0000" } };

    // Styling Header
    for (let i = 1; i <= 4; i++) {
      const cell = worksheet.getRow(1).getCell(i);
      cell.font = { bold: true };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE0F0FF" } };
    }

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=Template_Upload_Ranking.xlsx");

    await workbook.xlsx.write(res);
    res.status(200).end();
  } catch (error) {
    console.error("Error download template:", error);
    return errorResponse(res, "Gagal mendownload template Excel");
  }
};