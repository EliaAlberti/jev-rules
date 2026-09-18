const VAT = 0.2;
export const addTax = (pence: number): number => pence * (1 + VAT);
