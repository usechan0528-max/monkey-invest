CREATE TABLE `attempts` (
	`voter_hash` text NOT NULL,
	`bucket` integer NOT NULL,
	`count` integer NOT NULL,
	PRIMARY KEY(`voter_hash`, `bucket`),
	FOREIGN KEY (`voter_hash`) REFERENCES `voters`(`token_hash`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `result_events` (
	`id` text PRIMARY KEY NOT NULL,
	`round_id` text NOT NULL,
	`revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`round_id`) REFERENCES `rounds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `result_round_revision` ON `result_events` (`round_id`,`revision`);--> statement-breakpoint
CREATE TABLE `rounds` (
	`id` text PRIMARY KEY NOT NULL,
	`config_json` text NOT NULL,
	`opens_at` integer NOT NULL,
	`deadline` integer NOT NULL,
	`closes_at` integer NOT NULL,
	`reveal_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `voters` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `votes` (
	`round_id` text NOT NULL,
	`voter_hash` text NOT NULL,
	`choice` text NOT NULL,
	`accepted_at` integer NOT NULL,
	PRIMARY KEY(`round_id`, `voter_hash`),
	FOREIGN KEY (`round_id`) REFERENCES `rounds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`voter_hash`) REFERENCES `voters`(`token_hash`) ON UPDATE no action ON DELETE no action
);
