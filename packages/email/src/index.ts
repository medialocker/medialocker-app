export { getTheme, type Theme } from './theme.js';
export { renderEmail, renderAndSend, type EmailTemplate, type Rendered } from './render.js';
export { dispatch, type SendResult, type DispatchInput } from './send.js';
export { getResend, resetResend } from './client.js';

export { sendWelcomeEmail, type WelcomeView } from './templates/welcome.js';
export { sendReceiptEmail, type ReceiptView } from './templates/receipt.js';
export { sendPaymentFailedEmail, type PaymentFailedView } from './templates/payment-failed.js';
export {
  sendSubscriptionCanceledEmail,
  type SubscriptionCanceledView,
} from './templates/subscription-canceled.js';
export { sendPlanChangedEmail, type PlanChangedView } from './templates/plan-changed.js';
export { sendCapacityAddedEmail, type CapacityAddedView } from './templates/capacity-added.js';
export {
  sendContactNotification,
  sendContactAck,
  type ContactMessage,
} from './templates/contact.js';
