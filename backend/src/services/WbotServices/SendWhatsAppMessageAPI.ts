import { delay, WAMessage } from "@whiskeysockets/baileys";
import * as Sentry from "@sentry/node";
import AppError from "../../errors/AppError";
import GetTicketWbot from "../../helpers/GetTicketWbot";
import Message from "../../models/Message";
import Ticket from "../../models/Ticket";

import formatBody from "../../helpers/Mustache";
import Contact from "../../models/Contact";
import { getWbot } from "../../libs/wbot";
import logger from "../../utils/logger";
import { ENABLE_LID_DEBUG } from "../../config/debug";
import { normalizeJid } from "../../utils";
interface Request {
  body: string;
  whatsappId: number;
  contact: Contact;
  quotedMsg?: Message;
  msdelay?: number;
}

const SendWhatsAppMessage = async ({
  body,
  whatsappId,
  contact,
  quotedMsg,
  msdelay
}: Request): Promise<WAMessage> => {
  let options = {};
  const wbot = await getWbot(whatsappId);

  // ✅ CORREÇÃO: Usar LID quando disponível para evitar erro Bad MAC
  let jid;
  if (contact.lid && contact.lid !== "") {
    jid = contact.lid;
    if (ENABLE_LID_DEBUG) {
      logger.info(`[LID-DEBUG] SendMessageAPI - Usando LID do campo lid: ${jid}`);
    }
  } else if (contact.remoteJid && contact.remoteJid.includes("@lid")) {
    // Extrair apenas o LID puro do remoteJid malformado
    const lidMatch = contact.remoteJid.match(/^(\d+)@lid/);
    if (lidMatch) {
      jid = `${lidMatch[1]}@lid`;
      if (ENABLE_LID_DEBUG) {
        logger.info(`[LID-DEBUG] SendMessageAPI - Extraindo LID puro do remoteJid: ${jid}`);
      }
    } else {
      // ✅ CORREÇÃO: Se o remoteJid contém @lid, usar diretamente
      if (contact.remoteJid && contact.remoteJid.includes('@lid')) {
        jid = contact.remoteJid;
        if (ENABLE_LID_DEBUG) {
          logger.info(`[LID-DEBUG] SendMessageAPI - Usando remoteJid LID diretamente: ${jid}`);
        }
      } else {
        // Fallback para JID tradicional se não conseguir extrair o LID
        const cleanNumber = contact.number.replace(/@.*$/, '');
        jid = contact.isGroup ? `${cleanNumber}@g.us` : contact.remoteJid;
        if (ENABLE_LID_DEBUG) {
          logger.info(`[LID-DEBUG] SendMessageAPI - Fallback para JID tradicional: ${jid}`);
        }
      }
    }
  } else {
    // ✅ CORREÇÃO: Se o remoteJid contém @lid, usar diretamente
    if (contact.remoteJid && contact.remoteJid.includes('@lid')) {
      jid = contact.remoteJid;
      if (ENABLE_LID_DEBUG) {
        logger.info(`[LID-DEBUG] SendMessageAPI - Usando remoteJid LID diretamente: ${jid}`);
      }
    } else {
      // Fallback para JID tradicional quando não há LID
      const cleanNumber = contact.number.replace(/@.*$/, '');
      jid = contact.isGroup ? `${cleanNumber}@g.us` : contact.remoteJid;
      if (ENABLE_LID_DEBUG) {
        logger.info(`[LID-DEBUG] SendMessageAPI - Usando JID tradicional: ${jid}`);
      }
    }
  }

  // ✅ CORREÇÃO: normalizeJid agora trata LIDs corretamente
  jid = normalizeJid(jid);

  if (ENABLE_LID_DEBUG) {
    logger.info(
      `[LID-DEBUG] SendMessageAPI - Enviando para JID tradicional: ${jid}`
    );
    logger.info(`[LID-DEBUG] SendMessageAPI - Contact lid: ${contact.lid}`);
    logger.info(
      `[LID-DEBUG] SendMessageAPI - Contact remoteJid: ${contact.remoteJid}`
    );
    logger.info(
      `[LID-DEBUG] SendMessageAPI - QuotedMsg: ${quotedMsg ? "SIM" : "NÃO"}`
    );
  }

  if (quotedMsg) {
    const quotedId: any = (quotedMsg as any)?.id ?? quotedMsg;
    let chatMessages: Message | null = null;
    if (quotedId !== undefined && quotedId !== null && String(quotedId).trim() !== "") {
      chatMessages = await Message.findOne({
        where: {
          id: quotedId
        }
      });
    }

    if (chatMessages) {
      const msgFound = JSON.parse(chatMessages.dataJson);

      options = {
        quoted: {
          key: msgFound.key,
          message: {
            extendedTextMessage: msgFound.message.extendedTextMessage
          }
        }
      };

      if (ENABLE_LID_DEBUG) {
        logger.info(
          `[LID-DEBUG] SendMessageAPI - ContextInfo configurado para resposta`
        );
      }
    }
  }

  try {
    await delay(msdelay);

    const messageContent: any = {
      text: body
    };

    if (quotedMsg) {
      messageContent.contextInfo = {
        forwardingScore: 0,
        isForwarded: false
      };

      if (ENABLE_LID_DEBUG) {
        logger.info(
          `[LID-DEBUG] SendMessageAPI - ContextInfo adicionado para resposta`
        );
      }
    }

    const sentMessage = await wbot.sendMessage(jid, messageContent, {
      ...options
    });

    if (ENABLE_LID_DEBUG) {
      logger.info(
        `[LID-DEBUG] SendMessageAPI - Mensagem enviada com sucesso para ${jid}`
      );
    }

    return sentMessage;
  } catch (err) {
    Sentry.captureException(err);
    console.log(err);
    throw new AppError("ERR_SENDING_WAPP_MSG");
  }
};

export default SendWhatsAppMessage;
