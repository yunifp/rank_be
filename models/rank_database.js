const { DataTypes } = require("sequelize");
const { sequelize } = require("../core/db_config");

const TrxKeputusan = sequelize.define(
  "RankDatabase",
  {
    id: {
      type: DataTypes.INTEGER(11),
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },

    id_trx_beasiswa: { // <--- PERBAIKAN DISINI (sebelumnya id_trx_beasis)
      type: DataTypes.INTEGER(11),
      allowNull: true,
    },

    nama: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },

    nilai_akhir: {
      type: DataTypes.DECIMAL(20, 6),
      allowNull: true,
    },

    kluster: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },

    id_pt: {
      type: DataTypes.INTEGER(11),
      allowNull: true,
    },

    id_prodi: {
      type: DataTypes.INTEGER(11),
      allowNull: true,
    },

    status_mundur: { 
      type: DataTypes.ENUM("Y", "N"),
      allowNull: true,
      defaultValue: "N",
    },

    timestamp: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "rank_database",
    timestamps: false,
  }
);

module.exports = TrxKeputusan;