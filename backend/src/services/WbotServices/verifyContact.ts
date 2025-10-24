import { Mutex } from "async-mutex";
import { Op } from "sequelize";
import Contact from "../../models/Contact";
import CreateOrUpdateContactService, {
  updateContact
} from "../ContactServices/CreateOrUpdateContactService";
import Message from "../../models/Message";
import Ticket from "../../models/Ticket";
import UpdateTicketService from "../TicketServices/UpdateTicketService";
import { proto, WASocket } from "@whiskeysockets/baileys";
import WhatsappLidMap from "../../models/WhatsapplidMap";
import GetProfilePicUrl from "./GetProfilePicUrl";

const lidUpdateMutex = new Mutex();

// Constante para debug LID
const ENABLE_LID_DEBUG = true;

// Função auxiliar para criar mapeamento LID de forma segura
const createLidMappingSafely = async (companyId: number, lid: string, contactId: number) => {
  try {
    console.log(`[RDS CONTATO] Tentando criar mapeamento LID para contato ${contactId} com LID ${lid}`);
    
    // Verificar se o contato ainda existe antes de criar o mapeamento
    const contactExists = await Contact.findByPk(contactId);
    if (!contactExists) {
      console.log(`[RDS CONTATO] Contato ${contactId} não encontrado na base de dados, pulando criação de mapeamento LID`);
      return false;
    }

    // Usar findOrCreate para evitar problemas de concorrência
    const [mapping, created] = await WhatsappLidMap.findOrCreate({
      where: {
        companyId,
        lid
      },
      defaults: {
        companyId,
        lid,
        contactId
      }
    });

    if (created) {
      console.log(`[RDS CONTATO] Novo mapeamento LID criado com sucesso para contato ${contactId}`);
    } else {
      // Se o mapeamento já existia, atualizar o contactId se necessário
      if (mapping.contactId !== contactId) {
        console.log(`[RDS CONTATO] Mapeamento LID já existe para LID ${lid} na empresa ${companyId}, atualizando contactId de ${mapping.contactId} para ${contactId}`);
        await mapping.update({ contactId });
        console.log(`[RDS CONTATO] Mapeamento LID atualizado com sucesso para contato ${contactId}`);
      } else {
        console.log(`[RDS CONTATO] Mapeamento LID já existe e está correto para contato ${contactId}`);
      }
    }

    return true;
  } catch (error) {
    console.log(`[RDS CONTATO] Erro ao criar mapeamento LID para contato ${contactId}:`, error);
    return false;
  }
};

export type Session = WASocket & {
  id?: number;
  myJid?: string;
  myLid?: string;
  cacheMessage?: (msg: proto.IWebMessageInfo) => void;
  isRefreshing?: boolean;
};

interface IMe {
  name: string;
  id: string;
}

export async function checkAndDedup(
  contact: Contact,
  lid: string
): Promise<void> {
  console.log(`[RDS CONTATO] Verificando duplicação para contato ${contact.id} (${contact.number}) com LID ${lid}`);
  
  // ✅ CORREÇÃO: Buscar contatos duplicados considerando diferentes formatos de número
  const lidNumber = lid.substring(0, lid.indexOf("@"));
  
  const lidContact = await Contact.findOne({
    where: {
      companyId: contact.companyId,
      [Op.or]: [
        // Buscar por LID exato
        { number: lid },
        // Buscar por número puro do LID
        { number: lidNumber },
        // Buscar por LID no campo lid
        { lid: lid },
        // Buscar por número puro no campo lid
        { lid: `${lidNumber}@lid` },
        // Buscar por número puro em diferentes formatos
        { number: `${lidNumber}@s.whatsapp.net` },
        { number: `${lidNumber}@lid@s.whatsapp.net` }
      ]
    }
  });

  if (!lidContact) {
    console.log(`[RDS CONTATO] Nenhum contato duplicado encontrado para LID ${lid}`);
    return;
  }

  // Evitar que o contato seja comparado consigo mesmo
  if (lidContact.id === contact.id) {
    console.log(`[RDS CONTATO] Contato ${contact.id} é o mesmo contato encontrado, pulando deduplicação`);
    return;
  }

  console.log(`[RDS CONTATO] Contato duplicado encontrado: ${lidContact.id} (${lidContact.number}) - iniciando consolidação`);

  await Message.update(
    { contactId: contact.id },
    {
      where: {
        contactId: lidContact.id,
        companyId: contact.companyId
      }
    }
  );

  const notClosedTickets = await Ticket.findAll({
    where: {
      contactId: lidContact.id,
      status: {
        [Op.not]: "closed"
      }
    }
  });

  // eslint-disable-next-line no-restricted-syntax
  for (const ticket of notClosedTickets) {
    // eslint-disable-next-line no-await-in-loop
    await UpdateTicketService({
      ticketData: { status: "closed" },
      ticketId: ticket.id,
      companyId: ticket.companyId
    });
  }

  await Ticket.update(
    { contactId: contact.id },
    {
      where: {
        contactId: lidContact.id,
        companyId: contact.companyId
      }
    }
  );

  console.log(`[RDS CONTATO] Deletando contato duplicado: ${lidContact.id} (${lidContact.number}) para consolidar com contato ${contact.id} (${contact.number})`);
  await lidContact.destroy();
}

export async function verifyContact(
  msgContact: IMe,
  wbot: Session,
  companyId: number
): Promise<Contact> {
  let profilePicUrl: string;

  // try {
  //   profilePicUrl = await wbot.profilePictureUrl(msgContact.id);
  // } catch (e) {
  //   profilePicUrl = `${process.env.FRONTEND_URL}/nopicture.png`;
  // }

  const isLid = msgContact.id.includes("@lid");
  const isGroup = msgContact.id.includes("@g.us");

  // ✅ CORREÇÃO: SEMPRE usar número de telefone (PN) como identificador principal
  // Para LIDs, tentar obter o PN correspondente, senão usar o número extraído
  let number = msgContact.id.substring(0, msgContact.id.indexOf("@"));
  
  if (isLid) {
    try {
      // Tentar obter o PN correspondente ao LID usando o store interno do Baileys
      const store = (wbot as any).signalRepository?.lidMapping;
      if (store && typeof store.getPNForLID === 'function') {
        const pn = await store.getPNForLID(msgContact.id);
        if (pn) {
          number = pn.substring(0, pn.indexOf("@"));
          // ✅ CORREÇÃO: Remover sufixo :0 que o Baileys adiciona ao PN
          if (number.endsWith(':0')) {
            number = number.substring(0, number.length - 2);
          }
          if (ENABLE_LID_DEBUG) {
            console.log(`[LID-DEBUG] verifyContact - LID ${msgContact.id} mapeado para PN ${pn}, usando número ${number}`);
          }
        } else {
          if (ENABLE_LID_DEBUG) {
            console.log(`[LID-DEBUG] verifyContact - PN não encontrado para LID ${msgContact.id}, usando número extraído: ${number}`);
          }
        }
      }
    } catch (error) {
      console.log(`[LID-DEBUG] verifyContact - Erro ao obter PN para LID ${msgContact.id}:`, error);
    }
  }

  const contactData = {
    name: msgContact?.name || msgContact.id.replace(/\D/g, ""),
    number, // ✅ SEMPRE número de telefone (PN)
    profilePicUrl,
    isGroup: msgContact.id.includes("g.us"),
    companyId,
    lid: isLid ? msgContact.id : "", // Armazenar LID quando disponível
    remoteJid: msgContact.id // Sempre usar o JID original (pode ser LID ou PN)
  };

  if (isGroup) {
    return CreateOrUpdateContactService(contactData);
  }

  return lidUpdateMutex.runExclusive(async () => {
    // ✅ CORREÇÃO: Buscar contato pelo número de telefone (PN) - sempre usar o número principal
    const foundContact = await Contact.findOne({
      where: {
        companyId,
        number // Usar o número já processado (PN)
      },
      include: ["tags", "extraInfo", "whatsappLidMap"]
    });

    if (isLid) {
      if (foundContact) {
        // ✅ CORREÇÃO: Atualizar contato existente com informações do LID
        const updatedContact = await updateContact(foundContact, {
          profilePicUrl: contactData.profilePicUrl,
          lid: contactData.lid,
          remoteJid: contactData.remoteJid
        });
        
        // Criar mapeamento LID -> PN se necessário
        await createLidMappingSafely(companyId, msgContact.id, foundContact.id);
        
        return updatedContact;
      }

      // ✅ CORREÇÃO: Buscar contato mapeado pelo LID original
      const foundMappedContact = await WhatsappLidMap.findOne({
        where: {
          companyId,
          lid: msgContact.id // Usar o LID original, não o número
        },
        include: [
          {
            model: Contact,
            as: "contact",
            where: { companyId },
            include: ["tags", "extraInfo"]
          }
        ]
      });

      if (foundMappedContact) {
        // Atualizar contato existente com informações do LID
        const updatedContact = await updateContact(foundMappedContact.contact, {
          profilePicUrl: contactData.profilePicUrl,
          lid: contactData.lid,
          remoteJid: contactData.remoteJid
        });
        return updatedContact;
      }

      // ✅ CORREÇÃO: Criar novo contato com número de telefone (PN) e mapear para LID
      const newContact = await CreateOrUpdateContactService(contactData);
      await createLidMappingSafely(companyId, msgContact.id, newContact.id);
      return newContact;
    } else if (foundContact) {
      // ✅ CORREÇÃO: Para contatos PN normais, atualizar com informações atuais
      return updateContact(foundContact, {
        profilePicUrl: contactData.profilePicUrl,
        remoteJid: contactData.remoteJid
      });
    } else if (!isGroup && !foundContact) {
      try {
        const ow = await wbot.onWhatsApp(msgContact.id);
        if (!ow?.[0]?.exists) {
          console.log(`[RDS CONTATO] Contato ${msgContact.id} não encontrado no WhatsApp, criando como novo contato`);
          // Ao invés de lançar erro, vamos simplesmente criar o contato
          return CreateOrUpdateContactService(contactData);
        }
        const lid = ow?.[0]?.jid as string;

        if (lid) {
          const lidContact = await Contact.findOne({
            where: {
              companyId,
              number: {
                [Op.or]: [lid, lid.substring(0, lid.indexOf("@"))]
              }
            },
            include: ["tags", "extraInfo"]
          });

          if (lidContact && lidContact.id) {
            await createLidMappingSafely(companyId, lid, lidContact.id);
            return updateContact(lidContact, {
              number: contactData.number,
              profilePicUrl: contactData.profilePicUrl
            });
          }
        }
      } catch (error) {
        // Ignorar erro e continuar para criar contato
        console.log(`[RDS CONTATO] Erro ao verificar contato ${msgContact.id} no WhatsApp:`, error);
      }
    }

    return CreateOrUpdateContactService(contactData);
  });
}
