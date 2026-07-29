-- Cats and dogs become first-class event kinds, split out of 'animal'.
--
-- They are the animals people actually want alerts about, and separating them
-- matters for a second reason: a household pet is by far the most common thing
-- the detector mislabels as a person (observed repeatedly on real events at
-- 63-81% confidence). Giving pets their own kinds lets the alert filters treat
-- "the cat is on the deck" differently from "someone is on the deck".
--
-- 'animal' stays for birds, deer, livestock and anything else COCO recognises.
alter table public.events drop constraint events_kind_check;
alter table public.events add constraint events_kind_check
  check (kind in ('motion', 'person', 'vehicle', 'animal', 'cat', 'dog', 'package', 'bear'));
