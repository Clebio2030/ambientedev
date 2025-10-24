import fs from "fs";
import path from "path";
import FormData from "form-data";
import axios from "axios";
import Setting from "../../models/Setting";
import Company from "../../models/Company";
import Plan from "../../models/Plan";

// Response type for service return
export type TranscriptionResponse = { transcribedText: string } | string;

async function fetchOpenAIToken(companyId: number): Promise<string | null> {
  try {
    // tenta pela empresa atual
    let setting = await Setting.findOne({
      where: { companyId, key: "openaikeyaudio" }
    });
    // fallback para empresa master (1)
    if (!setting && companyId !== 1) {
      setting = await Setting.findOne({
        where: { companyId: 1, key: "openaikeyaudio" }
      });
    }
    return setting?.value || null;
  } catch (error) {
    console.error("Error retrieving settings:", error);
    return null;
  }
}

const TranscribeAudioMessageToText = async (
  fileName: string,
  companyId: number
): Promise<TranscriptionResponse> => {
  // verifica se o plano da empresa permite o recurso
  try {
    const company = await Company.findByPk(companyId);
    if (!company) {
      return "Empresa não encontrada";
    }
    const plan = await Plan.findByPk(company.planId);
    if (!plan || plan.useAudioTranscription === false) {
      return "Recurso de transcrição de áudio não habilitado no plano da empresa.";
    }
  } catch (e) {
    console.error("Erro ao verificar plano/useAudioTranscription", e);
    return "Falha ao verificar permissões do plano para transcrição de áudio";
  }

  const token = await fetchOpenAIToken(companyId);
  if (!token) return "Token OpenAI não configurado (setting 'openaikeyaudio').";

  const publicFolder = path.resolve(__dirname, "..", "..", "..", "public");
  const filePath = `${publicFolder}/company${companyId}/${fileName}`;

  if (!fs.existsSync(filePath)) {
    console.error(`Arquivo não encontrado: ${filePath}`);
    return "Arquivo não encontrado";
  }

  try {
    const audioFile = fs.createReadStream(filePath);
    const form = new FormData();
    form.append("file", audioFile);
    form.append("model", "whisper-1");
    form.append("response_format", "text");
    form.append("language", "pt");

    const response = await axios.post(
      "https://api.openai.com/v1/audio/transcriptions",
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${token}`
        }
      }
    );

    return { transcribedText: response.data };
  } catch (error) {
    // Melhorar logging e retorno de erro para diagnóstico
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const data = error.response?.data;
      console.error("OpenAI transcription error:", status, data || error.message);
      if (data?.error?.message) {
        return `Falha na API OpenAI: ${data.error.message}`;
      }
      return `Falha na API OpenAI${status ? ` (status ${status})` : ""}`;
    }
    console.error(error);
    return "Conversão pra texto falhou";
  }
};

export default TranscribeAudioMessageToText;
