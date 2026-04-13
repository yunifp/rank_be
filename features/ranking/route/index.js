const express = require("express");
const router = express.Router();

const {
  uploadDataRanking,
  prosesPerangkingan,
  getHasilRanking,
  downloadHasilRankingExcel,
  resetDataRanking,
  getFilterOptions,
  clearHasilRanking,
  getAllDatabaseUpload, 
  updateStatusMundur,
  getCadanganRanking,
  getSisaKuota,
  getDashboardStats,
  downloadTemplateRanking
} = require("../controller");
const { uploadConfigs } = require("../../../common/middleware/upload_middleware");

router.post("/upload", uploadConfigs.excel.single("file"), uploadDataRanking);
router.post("/proses", prosesPerangkingan);
router.get("/hasil", getHasilRanking);
router.get("/cadangan", getCadanganRanking); 
router.get("/download-hasil", downloadHasilRankingExcel);
router.get("/download-template", downloadTemplateRanking);
router.delete("/reset", resetDataRanking);
router.get("/kuota", getSisaKuota);
router.put("/clear", clearHasilRanking);
router.get("/options", getFilterOptions); 
router.get("/database-upload", getAllDatabaseUpload);
router.put("/status-mundur/:id_trx", updateStatusMundur);
router.get("/dashboard-stats", getDashboardStats);

module.exports = router;