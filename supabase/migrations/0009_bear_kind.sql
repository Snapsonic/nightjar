-- Bear gets first-class citizenship (bigger than a dog, smaller than a horse,
-- all black). YOLOX/COCO class 21 now maps to it directly on the node.
alter table public.events drop constraint events_kind_check;
alter table public.events add constraint events_kind_check
  check (kind in ('motion', 'person', 'vehicle', 'animal', 'package', 'bear'));
