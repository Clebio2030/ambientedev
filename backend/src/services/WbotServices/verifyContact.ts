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

// Função auxiliar para criar mapeamento LID de forma segura
const createLidMappingSafely = async (companyId: number, lid: string, contactId: number) => {
  try {
    console.log(`[RDS CONTATO] Tentando criar mapeamento LID para contato ${contactId} com LID ${lid}`);
    
    // Verificar se o contato ainda existe antes de criar o mapeamento
    const contactExists = await Contact.findByPk(contactId);
    if (contactExists) {
      console.log(`[RDS CONTATO] Contato ${contactId} encontrado, criando mapeamento LID`);
      await WhatsappLidMap.create({
        companyId,
        lid,
        contactId
      });
      console.log(`[RDS CONTATO] Mapeamento LID criado com sucesso para contato ${contactId}`);
      return true;
    } else {
      console.log(`[RDS CONTATO] Contato ${contactId} não encontrado na base de dados, pulando criação de mapeamento LID`);
      return false;
    }
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
  
  const lidContact = await Contact.findOne({
    where: {
      companyId: contact.companyId,
      number: {
        [Op.or]: [lid, lid.substring(0, lid.indexOf("@"))]
      }
    }
  });

  if (!lidContact) {
    console.log(`[RDS CONTATO] Nenhum contato duplicado encontrado para LID ${lid}`);
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

  const number = isLid
    ? msgContact.id
    : msgContact.id.substring(0, msgContact.id.indexOf("@"));

  const contactData = {
    name: msgContact?.name || msgContact.id.replace(/\D/g, ""),
    number,
    profilePicUrl,
    isGroup: msgContact.id.includes("g.us"),
    companyId
  };

  if (isGroup) {
    return CreateOrUpdateContactService(contactData);
  }

  return lidUpdateMutex.runExclusive(async () => {
    const foundContact = await Contact.findOne({
      where: {
        companyId,
        number
      },
      include: ["tags", "extraInfo", "whatsappLidMap"]
    });

    if (isLid) {
      if (foundContact) {
        return updateContact(foundContact, {
          profilePicUrl: contactData.profilePicUrl
        });
      }

      const foundMappedContact = await WhatsappLidMap.findOne({
        where: {
          companyId,
          lid: number
        },
        include: [
          {
            model: Contact,
            as: "contact",
            include: ["tags", "extraInfo"]
          }
        ]
      });

      if (foundMappedContact) {
        return updateContact(foundMappedContact.contact, {
          profilePicUrl: contactData.profilePicUrl
        });
      }

      const partialLidContact = await Contact.findOne({
        where: {
          companyId,
          number: number.substring(0, number.indexOf("@"))
        },
        include: ["tags", "extraInfo"]
      });

      if (partialLidContact) {
        return updateContact(partialLidContact, {
          number: contactData.number,
          profilePicUrl: contactData.profilePicUrl
        });
      }
    } else if (foundContact) {
      if (!foundContact.whatsappLidMap) {
        try {
          const ow = await wbot.onWhatsApp(msgContact.id);
          if (ow?.[0]?.exists) {
            const lid = ow?.[0]?.jid as string;
            if (lid && foundContact.id) {
              await checkAndDedup(foundContact, lid);
              
              await createLidMappingSafely(companyId, lid, foundContact.id);
            }
          } else {
            // Contato não existe no WhatsApp, mas vamos continuar mesmo assim
            console.log(`[RDS CONTATO] Contato ${msgContact.id} não encontrado no WhatsApp, mas continuando processamento`);
          }
        } catch (error) {
          // Ignorar erro de verificação e continuar
          console.log(`[RDS CONTATO] Erro ao verificar contato ${msgContact.id} no WhatsApp:`, error);
        }
      }
      return updateContact(foundContact, {
        profilePicUrl: contactData.profilePicUrl
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
