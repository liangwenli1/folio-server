import { ApiError } from '../errors.js';

export interface Card { number: string; expMonth: number; expYear: number; cvc: string }

// Stand-in for a card processor until a real one is connected. Test cards follow the usual convention:
// 4000 0000 0000 0002 is declined, 4000 0000 0000 9995 has insufficient funds, any other valid number succeeds.
export function chargeCard(card: Card, now: Date){
  const digits = card.number.replace(/[\s-]/g, '');
  if (!/^\d{12,19}$/.test(digits) || !luhn(digits)) throw new ApiError(402, 'card_invalid', 'The card number is not valid');
  if (!/^\d{3,4}$/.test(card.cvc)) throw new ApiError(402, 'card_invalid', 'The security code is not valid');
  const expiresAfter = Date.UTC(card.expYear, card.expMonth, 1);
  if (card.expMonth < 1 || card.expMonth > 12 || expiresAfter <= now.getTime()) throw new ApiError(402, 'card_expired', 'The card has expired');
  if (digits === '4000000000000002') throw new ApiError(402, 'card_declined', 'The card was declined');
  if (digits === '4000000000009995') throw new ApiError(402, 'insufficient_funds', 'The card has insufficient funds');
  return { brand: brandOf(digits), last4: digits.slice(-4) };
}

function luhn(digits: string){
  let sum = 0;
  for (let i = 0; i < digits.length; i++){
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1){ d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

function brandOf(d: string){
  if (d.startsWith('4')) return 'visa';
  if (/^(5[1-5]|2[2-7])/.test(d)) return 'mastercard';
  if (/^3[47]/.test(d)) return 'amex';
  return 'card';
}
