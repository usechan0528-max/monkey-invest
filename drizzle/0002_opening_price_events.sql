CREATE TABLE `opening_price_events` (
 `id` text PRIMARY KEY NOT NULL,
 `round_id` text NOT NULL,
 `revision` integer NOT NULL,
 `payload_json` text NOT NULL,
 `recorded_at` integer NOT NULL,
 FOREIGN KEY (`round_id`) REFERENCES `rounds`(`id`) ON UPDATE no action ON DELETE no action,
 CONSTRAINT `opening_price_revision_positive` CHECK (`revision` >= 1),
 CONSTRAINT `opening_price_payload_json` CHECK (json_valid(`payload_json`))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `opening_price_round_revision` ON `opening_price_events` (`round_id`,`revision`);
--> statement-breakpoint
CREATE TRIGGER `opening_price_immutable_insert` BEFORE INSERT ON `opening_price_events`
WHEN EXISTS (SELECT 1 FROM `opening_price_events` WHERE `id`=NEW.`id`)
BEGIN
 SELECT RAISE(ABORT, 'Opening price event immutable') WHERE EXISTS (SELECT 1 FROM `opening_price_events` WHERE `id`=NEW.`id` AND (`payload_json`<>NEW.`payload_json` OR `round_id`<>NEW.`round_id` OR `revision`<>NEW.`revision`));
 SELECT RAISE(IGNORE);
END;
--> statement-breakpoint
CREATE TRIGGER `opening_price_immutable_update` BEFORE UPDATE ON `opening_price_events`
BEGIN SELECT RAISE(ABORT, 'Opening price events are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `opening_price_immutable_delete` BEFORE DELETE ON `opening_price_events`
BEGIN SELECT RAISE(ABORT, 'Opening price events are append-only'); END;

--> statement-breakpoint
CREATE TRIGGER `opening_price_correction_chain` BEFORE INSERT ON `opening_price_events`
WHEN (NEW.`revision`=1 AND json_extract(NEW.`payload_json`,'$.correctsEventId') IS NOT NULL)
 OR (NEW.`revision`>1 AND NOT EXISTS (
  SELECT 1 FROM `opening_price_events` WHERE `id`=json_extract(NEW.`payload_json`,'$.correctsEventId')
   AND `round_id`=NEW.`round_id` AND `revision`=NEW.`revision`-1
 ))
BEGIN SELECT RAISE(ABORT, 'Invalid opening price correction chain'); END;
