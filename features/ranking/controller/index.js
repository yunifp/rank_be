const ExcelJS = require("exceljs");
const { Op } = require("sequelize");
const { 
  sequelize, 
  RankDatabase, 
  TrxPilihanProgramStudi, 
  RefProgramStudi,
  RefPerguruanTinggi,
  TrxBeasiswa
} = require("../../../models");
const { sequelizeMaster } = require("../../../core/db_master_config");
const { successResponse, errorResponse, failResponse } = require("../../../common/response");

RankDatabase.belongsTo(RefPerguruanTinggi, { foreignKey: "id_pt", targetKey: "id_pt" });
RankDatabase.belongsTo(RefProgramStudi, { foreignKey: "id_prodi", targetKey: "id_prodi" });
RankDatabase.belongsTo(TrxBeasiswa, { foreignKey: "id_trx_beasiswa", targetKey: "id_trx_beasiswa" });

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

    const beasiswaData = await TrxBeasiswa.findAll({
      where: { 
        kode_pendaftaran: { [Op.in]: kodeList },
        id_flow: 11 
      },
      attributes: ['id_trx_beasiswa', 'kode_pendaftaran'],
      raw: true
    });

    const mapKodeToId = {};
    beasiswaData.forEach(b => {
      mapKodeToId[b.kode_pendaftaran] = b.id_trx_beasiswa;
    });

    const dataToInsert = [];
    rawData.forEach(item => {
      const idTrx = mapKodeToId[item.kode_pendaftaran];
      if (idTrx) { 
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
      return failResponse(res, "Kode Pendaftaran dari Excel tidak ada yang cocok dengan Database, atau peserta tidak memiliki id_flow 11.");
    }

    await RankDatabase.bulkCreate(dataToInsert);

    return successResponse(res, `Berhasil mengupload ${dataToInsert.length} data untuk dirangking`);
  } catch (error) {
    console.error(error);
    return errorResponse(res, "Gagal mengupload file Excel");
  }
};

exports.prosesPerangkingan = async (req, res) => {
  const transactionLocal = await sequelize.transaction();
  const transactionMaster = await sequelizeMaster.transaction();
  
  try {
    const referensiProdi = await RefProgramStudi.findAll({ transaction: transactionMaster });

    const sisaKuota = {};
    const prodiToUpdate = {};
    referensiProdi.forEach((prodi) => {
      sisaKuota[`${prodi.id_pt}-${prodi.id_prodi}`] = prodi.kuota;
      prodiToUpdate[`${prodi.id_pt}-${prodi.id_prodi}`] = prodi;
    });

    const kandidat = await RankDatabase.findAll({
      where: {
        status_mundur: "N",
        id_pt: { [Op.is]: null },
        id_prodi: { [Op.is]: null }
      },
      order: [
        [sequelize.literal(`CASE WHEN LOWER(TRIM(kluster)) = 'afirmasi' THEN 1 ELSE 2 END`), "ASC"],
        ["nilai_akhir", "DESC"]
      ],
      transaction: transactionLocal
    });

    const kandidatIds = kandidat.map(k => k.id_trx_beasiswa);

    let semuaPilihan = [];
    if (kandidatIds.length > 0) {
      semuaPilihan = await TrxPilihanProgramStudi.findAll({
        where: { id_trx_beasiswa: { [Op.in]: kandidatIds } },
        order: [["id", "ASC"]],
        transaction: transactionLocal
      });
    }

    const mapPilihan = {};
    semuaPilihan.forEach(p => {
      if (!mapPilihan[p.id_trx_beasiswa]) {
        mapPilihan[p.id_trx_beasiswa] = [];
      }
      mapPilihan[p.id_trx_beasiswa].push(p);
    });

    let jumlahBerhasil = 0;
    const kandidatToUpdate = [];
    const prodiUpdates = new Set();

    for (let peserta of kandidat) {
      const pilihanList = mapPilihan[peserta.id_trx_beasiswa] || [];

      for (let pilihan of pilihanList) {
        const keyKuota = `${pilihan.id_pt}-${pilihan.id_prodi}`;

        if (sisaKuota[keyKuota] && sisaKuota[keyKuota] > 0) {
          peserta.id_pt = pilihan.id_pt;
          peserta.id_prodi = pilihan.id_prodi;

          kandidatToUpdate.push({
            id: peserta.id,
            id_trx_beasiswa: peserta.id_trx_beasiswa,
            id_pt: pilihan.id_pt,
            id_prodi: pilihan.id_prodi
          });

          sisaKuota[keyKuota] -= 1;
          prodiToUpdate[keyKuota].kuota = sisaKuota[keyKuota];
          prodiUpdates.add(keyKuota);

          jumlahBerhasil++;
          break;
        }
      }
    }

    if (kandidatToUpdate.length > 0) {
      await RankDatabase.bulkCreate(kandidatToUpdate, {
        updateOnDuplicate: ["id_pt", "id_prodi"],
        transaction: transactionLocal
      });
    }

    for (let key of prodiUpdates) {
      const prodi = prodiToUpdate[key];
      await RefProgramStudi.update(
        { kuota: prodi.kuota },
        { 
          where: { id_pt: prodi.id_pt, id_prodi: prodi.id_prodi }, 
          transaction: transactionMaster 
        }
      );
    }

    await transactionLocal.commit();
    await transactionMaster.commit();
    
    return successResponse(res, `Proses perangkingan selesai. ${jumlahBerhasil} kandidat berhasil dialokasikan.`);
  } catch (error) {
    await transactionLocal.rollback();
    await transactionMaster.rollback();
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
        { '$TrxBeasiswa.kode_pendaftaran$': { [Op.like]: `%${search}%` } },
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
        attributes: ['nama_prodi', 'jenjang'],
        where: filterProdi ? { nama_prodi: { [Op.like]: `%${filterProdi}%` } } : undefined,
        required: true
      });
    } else {
      includeOptions.push({ model: RefProgramStudi, attributes: ['nama_prodi', 'jenjang'] });
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
      nama_prodi: row.RefProgramStudi ? row.RefProgramStudi.nama_prodi : "-",
      jenjang: row.RefProgramStudi ? row.RefProgramStudi.jenjang : "-"
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
        { '$TrxBeasiswa.kode_pendaftaran$': { [Op.like]: `%${search}%` } },
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
        attributes: ['nama_prodi', 'jenjang'],
        where: filterProdi ? { nama_prodi: { [Op.like]: `%${filterProdi}%` } } : undefined,
        required: true
      });
    } else {
      includeOptions.push({ model: RefProgramStudi, attributes: ['nama_prodi', 'jenjang'] });
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
      { header: "Kode Pendaftaran", key: "kode_pendaftaran", width: 25 },
      { header: "Nama", key: "nama", width: 30 },
      { header: "Nilai Akhir", key: "nilai", width: 15 },
      { header: "Kluster", key: "kluster", width: 15 },
      { header: "ID PT Final", key: "id_pt", width: 15 },
      { header: "PT Final", key: "pt", width: 35 },
      { header: "Jenjang", key: "jenjang", width: 15 },
      { header: "ID Prodi Final", key: "id_prodi", width: 15 },
      { header: "Prodi Final", key: "prodi", width: 35 },
    ];

    hasil.forEach((row, index) => {
      worksheet.addRow({
        no: index + 1,
        kode_pendaftaran: row.TrxBeasiswa ? row.TrxBeasiswa.kode_pendaftaran : "-",
        nama: row.nama,
        nilai: row.nilai_akhir,
        kluster: row.kluster,
        id_pt: row.id_pt || "-",
        pt: row.RefPerguruanTinggi ? row.RefPerguruanTinggi.nama_pt : "-",
        jenjang: row.RefProgramStudi ? row.RefProgramStudi.jenjang : "-",
        id_prodi: row.id_prodi || "-",
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
  const transactionLocal = await sequelize.transaction();
  const transactionMaster = await sequelizeMaster.transaction();
  
  try {
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
      group: ['id_pt', 'id_prodi'],
      transaction: transactionLocal
    });

    for (let item of terpakaiData) {
      const id_pt = item.id_pt;
      const id_prodi = item.id_prodi;
      const total_terpakai = parseInt(item.get('total_terpakai'), 10);

      await RefProgramStudi.increment('kuota', {
        by: total_terpakai,
        where: { id_pt, id_prodi },
        transaction: transactionMaster
      });
    }

    await RankDatabase.update(
      { id_pt: null, id_prodi: null },
      { where: {}, transaction: transactionLocal }
    );

    await transactionLocal.commit();
    await transactionMaster.commit();
    
    return successResponse(res, "Hasil perangkingan berhasil dibersihkan. Data siap dirangking ulang.");
  } catch (error) {
    await transactionLocal.rollback();
    await transactionMaster.rollback();
    console.error(error);
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
        { '$TrxBeasiswa.kode_pendaftaran$': { [Op.like]: `%${search}%` } },
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
  const transactionLocal = await sequelize.transaction();
  const transactionMaster = await sequelizeMaster.transaction();
  
  try {
    const { id_trx } = req.params;
    const { status_mundur } = req.body;

    const peserta = await RankDatabase.findOne({
      where: { id_trx_beasiswa: id_trx },
      transaction: transactionLocal
    });

    if (!peserta) {
      await transactionLocal.rollback();
      await transactionMaster.rollback();
      return failResponse(res, "Data peserta tidak ditemukan");
    }

    if (status_mundur === "Y" && (!peserta.id_pt || !peserta.id_prodi)) {
      await transactionLocal.rollback();
      await transactionMaster.rollback();
      return failResponse(res, "Set mundur hanya dapat dilakukan untuk peserta yang lolos (memiliki PT dan Prodi final), bukan cadangan.");
    }

    if (status_mundur === "Y") {
      if (peserta.id_pt && peserta.id_prodi) {
        const prodi = await RefProgramStudi.findOne({
          where: { id_pt: peserta.id_pt, id_prodi: peserta.id_prodi },
          transaction: transactionMaster
        });
        if (prodi) {
          prodi.kuota += 1;
          await prodi.save({ transaction: transactionMaster });
        }
      }
      peserta.status_mundur = "Y";
      peserta.id_pt = null;
      peserta.id_prodi = null;
    } else if (status_mundur === "N") {
      peserta.status_mundur = "N";
    }

    await peserta.save({ transaction: transactionLocal });
    
    await transactionLocal.commit();
    await transactionMaster.commit();

    const pesan = status_mundur === "Y" ? "berhasil ditandai sebagai Mengundurkan Diri dan kuota telah dikembalikan" : "berhasil dikembalikan statusnya menjadi cadangan";
    return successResponse(res, `Peserta ${peserta.nama} ${pesan}. Silakan lakukan Proses Perangkingan ulang untuk mengisi kekosongan kuota.`);
  } catch (error) {
    await transactionLocal.rollback();
    await transactionMaster.rollback();
    console.error(error);
    return errorResponse(res, "Gagal mengubah status mundur peserta");
  }
};

exports.getCadanganRanking = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || "";
    const offset = (page - 1) * limit;

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

    RefProgramStudi.belongsTo(RefPerguruanTinggi, { foreignKey: 'id_pt', targetKey: 'id_pt' });

    const whereClause = {};
    if (search) {
      whereClause[Op.or] = [
        { nama_prodi: { [Op.like]: `%${search}%` } },
        { '$RefPerguruanTinggi.nama_pt$': { [Op.like]: `%${search}%` } }
      ];
    }

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

    const mapTerpakai = {};
    terpakaiData.forEach(item => {
      const pt = item.id_pt;
      const prodi = item.id_prodi;
      const total = item.get('total_terpakai');
      mapTerpakai[`${pt}-${prodi}`] = parseInt(total, 10);
    });

    const formattedData = rows.map(row => {
      const ptId = row.id_pt;
      const prodiId = row.id_prodi;
      const terpakai = mapTerpakai[`${ptId}-${prodiId}`] || 0;
      const sisa = row.kuota || 0;
      const kuotaMaster = sisa + terpakai;

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
    console.error(error);
    return errorResponse(res, "Gagal memuat data kuota program studi");
  }
};

exports.getDashboardStats = async (req, res) => {
  try {
    const totalDataMentah = await RankDatabase.count();
    const totalAfirmasi = await RankDatabase.count({ where: { kluster: 'Afirmasi' } });
    const totalReguler = await RankDatabase.count({ where: { kluster: 'Reguler' } });

    const totalProses = await RankDatabase.count({
      where: { id_pt: { [Op.ne]: null }, id_prodi: { [Op.ne]: null } }
    });
    const totalProsesAfirmasi = await RankDatabase.count({
      where: { id_pt: { [Op.ne]: null }, id_prodi: { [Op.ne]: null }, kluster: 'Afirmasi' }
    });
    const totalProsesReguler = await RankDatabase.count({
      where: { id_pt: { [Op.ne]: null }, id_prodi: { [Op.ne]: null }, kluster: 'Reguler' }
    });

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

exports.downloadTemplateRanking = async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Template Upload Ranking");

    worksheet.columns = [
      { header: "Kode Pendaftaran", key: "kode", width: 25 },
      { header: "Nama Lengkap", key: "nama", width: 35 },
      { header: "Nilai Akhir", key: "nilai", width: 15 },
      { header: "Kluster", key: "kluster", width: 20 },
    ];

    worksheet.addRow({
      kode: "2601000001",
      nama: "Contoh Nama Peserta",
      nilai: 85.50,
      kluster: "Reguler" 
    });

    worksheet.addRow(["", "", "", ""]); 
    const noteRow = worksheet.addRow(["CATATAN: Hapus baris 2 (contoh data) sebelum upload. Jangan ubah urutan header di baris 1."]);
    worksheet.mergeCells(`A${noteRow.number}:D${noteRow.number}`);
    noteRow.font = { italic: true, color: { argb: "FFFF0000" } };

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

exports.uploadDataHasilRanking = async (req, res) => {
  try {
    if (!req.file) return failResponse(res, "File Excel tidak ditemukan");

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const worksheet = workbook.worksheets[0];

    if (!worksheet) return failResponse(res, "Sheet tidak ditemukan di dalam file Excel");

    const getCellValue = (cell) => {
      if (!cell || cell.value == null) return "";
      if (typeof cell.value === 'object') {
        if (cell.value.richText) return cell.value.richText.map(rt => rt.text).join("");
        if (cell.value.result !== undefined) return cell.value.result;
      }
      return cell.value;
    };

    // Default mapping index sesuai screenshot (berjaga-jaga jika header beda nama)
    let cKode = 2, cNama = 3, cNilai = 4, cKluster = 5, cIdPt = 6, cJenjang = 8, cIdProdi = 9;

    // Deteksi Header Dinamis
    const headerRow = worksheet.getRow(1);
    headerRow.eachCell((cell, colNumber) => {
      const val = getCellValue(cell).toString().toLowerCase().replace(/\s+/g, '');
      if (val.includes("kodependaftaran") || val.includes("kode")) cKode = colNumber;
      if (val.includes("nama")) cNama = colNumber;
      // Mengatasi typo "Nila Akhir" di Excel
      if (val.includes("nilai") || val.includes("nilaakhir")) cNilai = colNumber; 
      if (val.includes("kluster")) cKluster = colNumber;
      if (val.includes("idpt")) cIdPt = colNumber;
      if (val.includes("idprodi")) cIdProdi = colNumber;
      if (val.includes("jenjang")) cJenjang = colNumber;
    });

    const rawData = [];
    const kodeList = [];

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1) {
        const kode = getCellValue(row.getCell(cKode)).toString().trim();
        if (kode) {
          kodeList.push(kode);
          const rawIdPt = getCellValue(row.getCell(cIdPt));
          const rawIdProdi = getCellValue(row.getCell(cIdProdi));
          const rawNilai = getCellValue(row.getCell(cNilai));

          const id_pt = rawIdPt ? parseInt(rawIdPt.toString().replace(/\D/g, ''), 10) : null;
          const id_prodi = rawIdProdi ? parseInt(rawIdProdi.toString().replace(/\D/g, ''), 10) : null;
          
          // Replace koma menjadi titik untuk nilai (misal: 3,8 -> 3.8)
          const nilai_akhir = rawNilai ? parseFloat(rawNilai.toString().replace(',', '.')) : 0;

          rawData.push({
            kode_pendaftaran: kode,
            nama: getCellValue(row.getCell(cNama)).toString().trim() || "Bypass",
            nilai_akhir: isNaN(nilai_akhir) ? 0 : nilai_akhir,
            kluster: getCellValue(row.getCell(cKluster)).toString().trim() || "Reguler",
            jenjang: getCellValue(row.getCell(cJenjang)).toString().trim() || null,
            id_pt: isNaN(id_pt) ? null : id_pt,
            id_prodi: isNaN(id_prodi) ? null : id_prodi,
          });
        }
      }
    });

    if (rawData.length === 0) return failResponse(res, "Tidak ada data yang terbaca dari Excel.");

    // Cari data yang sudah ada di database
    const beasiswaData = await TrxBeasiswa.findAll({
      where: { kode_pendaftaran: { [Op.in]: kodeList } },
      attributes: ['id_trx_beasiswa', 'kode_pendaftaran']
    });

    const mapKodeToId = {};
    beasiswaData.forEach(b => {
      mapKodeToId[b.kode_pendaftaran] = b.id_trx_beasiswa;
    });

    const dataToInsert = [];
    let berhasilDibuat = 0;
    let berhasilDiupdate = 0;

    for (let item of rawData) {
      let idTrx = mapKodeToId[item.kode_pendaftaran];

      if (!idTrx) {
        // JIKA BELUM ADA -> CREATE BYPASS
        try {
          const newDummy = await TrxBeasiswa.create({
            kode_pendaftaran: item.kode_pendaftaran,
            nama_lengkap: item.nama,
            nama_kluster: item.kluster,
            jenjang_sekolah: item.jenjang,
            jenjang_final: item.jenjang,
            hasil_tes_seleksi: item.nilai_akhir, // Insert nilai ke tabel utama
            id_flow: 11
          });
          idTrx = newDummy.id_trx_beasiswa;
          berhasilDibuat++;
        } catch (e) {
          console.error("Gagal create bypass data:", e);
        }
      } else {
        // JIKA SUDAH ADA -> UPDATE DATA TERSEBUT
        try {
          await TrxBeasiswa.update({
            nama_lengkap: item.nama,
            nama_kluster: item.kluster,
            jenjang_sekolah: item.jenjang,
            jenjang_final: item.jenjang,
            hasil_tes_seleksi: item.nilai_akhir // Update nilai ke tabel utama
          }, {
            where: { id_trx_beasiswa: idTrx }
          });
          berhasilDiupdate++;
        } catch (e) {
          console.error("Gagal update data TrxBeasiswa:", e);
        }
      }

      // Siapkan data untuk masuk ke tabel RankDatabase
      if (idTrx) {
        dataToInsert.push({
          id_trx_beasiswa: idTrx,
          nama: item.nama,
          nilai_akhir: item.nilai_akhir,
          kluster: item.kluster,
          id_pt: item.id_pt,
          id_prodi: item.id_prodi,
          status_mundur: "N",
          timestamp: new Date()
        });
      }
    }

    if (dataToInsert.length === 0) {
      return failResponse(res, "Bypass Gagal: Tidak ada data yang bisa diinsert ke tabel perangkingan.");
    }

    // Insert / Update ke RankDatabase
    await RankDatabase.bulkCreate(dataToInsert, {
      updateOnDuplicate: ["id_pt", "id_prodi", "nilai_akhir", "kluster", "nama", "status_mundur", "timestamp"]
    });

    return successResponse(res, `Berhasil memproses Excel. ${berhasilDibuat} data baru dibuat, ${berhasilDiupdate} data lama diupdate.`);
  } catch (error) {
    console.error("Error uploadDataHasilRanking:", error);
    return errorResponse(res, "Gagal mengupload file Excel bypass");
  }
};