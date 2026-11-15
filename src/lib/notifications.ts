import axios from 'axios';
import { NotificationPreference, NotificationType, TopicType, UserRole } from '@prisma/client';
import { prisma } from './prisma';
import { emitToUser } from './socket';

interface ExpoPushMessage {
  to: string;
  sound?: 'default';
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

function shouldNotifyByPreference(
  pref: NotificationPreference | null,
  type: NotificationType,
  topic?: TopicType | null
): boolean {
  if (!pref) return type !== 'TOPIC_CHAT';

  switch (type) {
    case 'NEW_POST':
    case 'MATCH_UPDATE':
      if (topic === 'FOOTBALL') return pref.footballPosts;
      if (topic === 'STREAMING') return pref.streamingPosts;
      if (topic === 'NEWS') return pref.newsPosts;
      if (topic === 'TV_CHANNELS') return pref.tvPosts;
      return true;
    case 'NEW_POLL':
      return pref.polls;
    case 'GIVEAWAY_OPEN':
    case 'GIVEAWAY_LIVE':
    case 'GIVEAWAY_WIN':
      return pref.giveaways || type === 'GIVEAWAY_WIN';
    case 'DIRECT_MESSAGE':
      return pref.directMessages;
    case 'SUGGESTION_UPDATE':
      return pref.adminSuggestions || pref.directMessages;
    case 'TOPIC_CHAT':
      return pref.topicChats;
    case 'SYSTEM':
    default:
      return true;
  }
}

async function sendExpoPushBatch(messages: ExpoPushMessage[]): Promise<void> {
  if (messages.length === 0) return;
  const chunks: ExpoPushMessage[][] = [];
  for (let i = 0; i < messages.length; i += 90) {
    chunks.push(messages.slice(i, i + 90));
  }
  for (const chunk of chunks) {
    try {
      await axios.post('https://exp.host/--/api/v2/push/send', chunk, {
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        timeout: 6000,
      });
    } catch {
      // Push delivery is best-effort and must never fail the API request
    }
  }
}

export interface DispatchNotificationInput {
  type: NotificationType;
  title: string;
  body: string;
  topic?: TopicType | null;
  referenceId?: string | null;
  referenceType?: string | null;
  targetUserIds?: string[];
  targetRoles?: UserRole[];
  excludeUserId?: string;
}

/**
 * Crea notificaciones in-app respetando NotificationPreference de cada usuario,
 * emite eventos en tiempo real vía Socket.IO y despacha Expo Push si corresponde.
 */
export async function dispatchNotifications(input: DispatchNotificationInput): Promise<void> {
  const whereClause: Record<string, unknown> = { isActive: true };
  if (input.targetUserIds && input.targetUserIds.length > 0) {
    whereClause.id = { in: input.targetUserIds };
  }
  if (input.targetRoles && input.targetRoles.length > 0) {
    whereClause.role = { in: input.targetRoles };
  }

  const users = await prisma.user.findMany({
    where: whereClause,
    select: {
      id: true,
      expoPushToken: true,
      notificationPreference: true,
    },
  });

  const recipients = users.filter((u) => {
    if (input.excludeUserId && u.id === input.excludeUserId) return false;
    return shouldNotifyByPreference(u.notificationPreference, input.type, input.topic);
  });

  if (recipients.length === 0) return;

  const created = await Promise.all(
    recipients.map((u) =>
      prisma.notification.create({
        data: {
          userId: u.id,
          type: input.type,
          title: input.title.slice(0, 200),
          body: input.body.slice(0, 500),
          topic: input.topic ?? null,
          referenceId: input.referenceId ?? null,
          referenceType: input.referenceType ?? null,
        },
      })
    )
  );

  const pushQueue: ExpoPushMessage[] = [];

  for (let i = 0; i < recipients.length; i++) {
    const recipient = recipients[i];
    const notif = created[i];
    emitToUser(recipient.id, 'notification:new', notif);

    const canPush =
      recipient.notificationPreference?.pushEnabled !== false &&
      Boolean(recipient.expoPushToken) &&
      recipient.expoPushToken!.startsWith('ExponentPushToken[');

    if (canPush && recipient.expoPushToken) {
      pushQueue.push({
        to: recipient.expoPushToken,
        sound: 'default',
        title: notif.title,
        body: notif.body,
        data: {
          notificationId: notif.id,
          type: notif.type,
          topic: notif.topic,
          referenceId: notif.referenceId,
          referenceType: notif.referenceType,
        },
      });
    }
  }

  if (pushQueue.length > 0) {
    void sendExpoPushBatch(pushQueue);
  }
}
