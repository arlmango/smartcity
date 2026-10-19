# Final gate 2 (commit c468832): live smoke FAIL — product defect, fixed in ba066fe

- `make verify` 11/11 exit 0; live smoke: Playwright 24 passed, pytest live **1 failed / 2 passed**.
- Failed: API live S1 required `mode=live_rag`, got `degraded/retrieval_only`: both model attempts were
  rejected with "ни одна рекомендация не прошла проверку" — the strict claim filter removed every text,
  so the model's valid selection (known place IDs only) was discarded and the server fell back.
- Frequency in this session: ~1 of 4 live generations needed a retry; occasionally both attempts fail.
- Fix (ba066fe): on the last attempt the model's selection is kept with the failing texts hidden
  (`reason=null`, warning `llm_text_rejected`, UI "Объяснение ИИ не прошло проверку фактов и скрыто"),
  except when the model also invented IDs (then honest fallback, T15). Tests: test_generation
  `test_last_attempt_keeps_selection_when_all_texts_fail_checks`, web unit card test.
