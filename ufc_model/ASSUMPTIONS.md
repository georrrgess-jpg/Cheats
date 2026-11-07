# Assumptions (one line each, with the reason)

- Data source: the Greco1899/scrape_ufc_stats GitHub dataset instead of scraping UFCStats directly. Reason: UFCStats serves a JS proof-of-work bot check, and §7.5 forbids getting around it.
- Card source: ESPN public API + Wikipedia (which cites UFC.com). Reason: UFC.com returns 403 here.
- The dataset has fighter names but no fighter IDs in results and stats. IDs are joined by normalized name. 7 duplicate names in UFC history (e.g. Bruno Silva) go to the ID whose listed weight is closest to the bout's division. Reason: the only key available. None of them are on tonight's card.
- 43 historical fights have a fighter missing from the fighter table. They're excluded from features and outcome models. Reason: no ID.
- "Jose Henrique" (UFCStats, 170 lb, b. 2002) = José Henrique Souza (the card). Reason: BFO lists him as both "Jose Souza" and "Jose Henrique", and he's the only token-subset match.
- League rates (per weight class/gender) are computed once from 2010+ data and used as constants in the as-of features. Reason: speed. This is a slight look-ahead in the backtest, but on population constants only, not on any fighter.
- Position time: ground time ≈ (control time A + control time B); standing time = fight time − ground time (floor 5%). Reason: UFCStats doesn't publish position time (§14.2).
- Sub-attempt exposure = own top minutes + 0.15 × standing minutes. Reason: submissions come mostly from top, with a small scramble/front-choke baseline.
- Stats from before 2010 feed Elo only, not rate features. Reason: the stats are sparser and less reliable (§9).
- Catchweight bouts use the all-divisions league rates for that gender. Reason: few of them, and they don't map cleanly to one division.
- APEX flag = Las Vegas Fight Night/ESPN events from 2020-05-30 on. Reason: no venue field in the dataset.
- Elo: debutants start 60 points below the mean; K is 1.5× for a fighter's first 3 fights. Reason: debut win rates are below 50% and new fighters' ratings should move faster.
- Win-model features are antisymmetric differences, fit with no intercept on both orientations. Reason: symmetry by construction (§13).
