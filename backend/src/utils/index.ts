// Utilitário para normalizar JIDs do WhatsApp
// ✅ CORREÇÃO: Segundo Baileys v7.0.0, LIDs devem ser usados diretamente, não convertidos

export function normalizeJid(jid: string): string {
  if (!jid) return jid;

  // Corrige casos onde o jid vem duplicado, ex: 5519981790250@s.whatsapp.net@s.whatsapp.net
  if (jid.includes('@s.whatsapp.net@s.whatsapp.net')) {
    return jid.replace('@s.whatsapp.net@s.whatsapp.net', '@s.whatsapp.net');
  }
  if (jid.includes('@g.us@g.us')) {
    return jid.replace('@g.us@g.us', '@g.us');
  }

  // ✅ CORREÇÃO: LIDs devem ser mantidos como estão, não convertidos
  if (jid.includes('@lid')) {
    return jid; // Retornar LID sem modificação
  }

  // Se já contém @s.whatsapp.net ou @g.us, retorna o próprio jid
  if (jid.includes('@s.whatsapp.net') || jid.includes('@g.us')) {
    return jid;
  }

  // Para números sem sufixo, adicionar @s.whatsapp.net
  return jid + '@s.whatsapp.net';
} 