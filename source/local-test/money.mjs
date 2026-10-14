const invalid = message => { throw Object.assign(new Error(message), { status: 400 }); };
export function scaled(value, digits = 2, label = 'amount') {
  const s = String(value ?? '0').trim();
  if (!new RegExp(`^\\d{1,10}(?:\\.\\d{1,${digits}})?$`).test(s)) invalid(`${label} must be nonnegative with at most ${digits} decimal places.`);
  const [whole, part = ''] = s.split('.');
  const n = BigInt(whole) * 10n ** BigInt(digits) + BigInt(part.padEnd(digits, '0'));
  if (n > 1000000000000n) invalid(`${label} is too large.`);
  return Number(n);
}
const round = (n,d) => Number((n+d/2n)/d);
export function lineAmounts(l) {
  const q=scaled(l.quantity,4,'Quantity'),p=scaled(l.unit_price,4,'Unit price');
  const percent=scaled(l.percentage_discount,4,'Percentage discount'),tax=scaled(l.tax_percent,4,'Tax percent');
  if(q<=0||percent>1000000||tax>1000000)invalid('Quantity must be positive; percentages must be between 0 and 100.');
  const amount=round(BigInt(q)*BigInt(p),1000000n);
  const discount=scaled(l.discount,2,'Discount')+round(BigInt(amount)*BigInt(percent),1000000n);
  if(amount>1000000000000||discount>amount)invalid('Discount exceeds the line amount, or the amount is too large.');
  const net=amount-discount,vat=round(BigInt(net)*BigInt(tax),1000000n);
  return {amount_cents:amount,discount_cents:discount,net_cents:net,vat_cents:vat,total_cents:net+vat};
}
