-- The hotel's name and place on every paper (2026-11-09, operator). Only the seeded demo values are
-- replaced, so a profile an admin has already filled in is left alone.
UPDATE "hotel_profile"
SET "hotelName" = 'Legphel Hotel',
    "registeredAddress" = CASE WHEN "registeredAddress" = 'Demo Registered Address' THEN 'Phuentsholing, Bhutan' ELSE "registeredAddress" END,
    "tradingAddress" = CASE WHEN "tradingAddress" IN ('Demo Trading Address', 'Demo Address') THEN 'Phuentsholing, Bhutan' ELSE "tradingAddress" END,
    "updatedAt" = now()
WHERE "hotelName" = 'Legphel Demo Hotel';
