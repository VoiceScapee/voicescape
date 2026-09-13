/**
 * Minimal type declarations for the `web-push` package (push delivery only).
 * The repo allows `web-push` as a dependency but no @types/* additions, so
 * the surface we use is declared locally instead.
 */
declare module "web-push" {
  export interface PushSubscriptionKeys {
    p256dh: string;
    auth: string;
  }
  export interface PushSubscription {
    endpoint: string;
    keys: PushSubscriptionKeys;
  }
  export interface VapidDetails {
    subject: string;
    publicKey: string;
    privateKey: string;
  }
  export function setVapidDetails(
    subject: string,
    publicKey: string,
    privateKey: string,
  ): void;
  export function sendNotification(
    subscription: PushSubscription,
    payload?: string | Buffer,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
}
