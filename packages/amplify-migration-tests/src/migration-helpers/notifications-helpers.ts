import {
  getCLIPath,
  nspawn as spawn,
} from '@aws-amplify/amplify-e2e-core';

/**
 * Adds notification resource for a given channel
 */
export const addLegacyNotificationChannel = async (
  cwd: string,
  channel: string,
  hasAuth = false,
): Promise<void> => {
  const chain = spawn(getCLIPath(false), ['add', 'notification'], { cwd, stripColors: true });

  chain
    .wait('Choose the push notification channel to enable')
    .sendLine(channel);

  if (!hasAuth) {
    chain
      .wait('Apps need authorization to send analytics events. Do you want to allow guests')
      .sendNo()
      .sendCarriageReturn();
  }

  return chain
    .wait(`The ${channel} channel has been successfully enabled`)
    .sendEof()
    .runAsync();
};
