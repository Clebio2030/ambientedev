import { QueryInterface } from "sequelize";

module.exports = {
  up: async (queryInterface: QueryInterface) => {
    await queryInterface.removeColumn("CompaniesSettings", "enableAudioTranscription");
  },

  down: async (queryInterface: QueryInterface) => {
    const { DataTypes } = require("sequelize");
    await queryInterface.addColumn("CompaniesSettings", "enableAudioTranscription", {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: "disabled",
    });
  }
};
