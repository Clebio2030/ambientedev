import { QueryInterface, DataTypes } from "sequelize";

module.exports = {
  up: async (queryInterface: QueryInterface) => {
    await queryInterface.addColumn("CompaniesSettings", "enableAudioTranscription", {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: "disabled",
    });
  },

  down: async (queryInterface: QueryInterface) => {
    await queryInterface.removeColumn("CompaniesSettings", "enableAudioTranscription");
  }
};
