# Eval results
date: 20261018T232420Z
api: http://127.0.0.1:8000

| id | split | status | mode | n | latency s | violations | misses |
|---|---|---|---|---|---|---|---|
| D01 | dev | ok | live_rag | 2 | 75.7 | 0 | 0 |
| D02 | dev | no_match | retrieval_only | 0 | 0.0 | 0 | 0 |
| D03 | dev | ok | live_rag | 3 | 63.0 | 0 | 0 |
| D04 | dev | ok | live_rag | 2 | 42.1 | 0 | no result in categories ['cafe'] |
| D05 | dev | ok | live_rag | 3 | 51.8 | 0 | 0 |
| D06 | dev | ok | live_rag | 2 | 47.1 | 0 | 0 |
| D07 | dev | no_match | retrieval_only | 0 | 0.2 | 0 | 0 |
| D08 | dev | ok | live_rag | 3 | 56.8 | 0 | no result in categories ['food', 'cafe'] |
| D09 | dev | ok | live_rag | 2 | 57.9 | 0 | 0 |
| D10 | dev | ok | live_rag | 2 | 45.9 | 0 | 0 |
| H01 | holdout | ok | live_rag | 2 | 39.2 | 0 | 0 |
| H02 | holdout | ok | live_rag | 1 | 54.3 | 0 | 0 |
| H03 | holdout | ok | live_rag | 1 | 47.8 | 0 | 0 |
| H04 | holdout | ok | live_rag | 3 | 58.8 | 0 | 0 |
| H05 | holdout | ok | live_rag | 2 | 36.2 | 0 | 0 |
| H06 | holdout | no_match | retrieval_only | 0 | 0.2 | 0 | 0 |
| H07 | holdout | ok | live_rag | 1 | 24.3 | 0 | 0 |
| H08 | holdout | no_match | retrieval_only | 0 | 0.2 | 0 | 0 |
| H09 | holdout | needs_clarification | retrieval_only | 0 | 0.0 | 0 | 0 |
| H10 | holdout | degraded | retrieval_only | 3 | 79.2 | 0 | 0 |

hard-constraint/grounding violations: 0
