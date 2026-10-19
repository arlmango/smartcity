# Eval results
date: 20261018T210726Z
api: http://127.0.0.1:8000

| id | split | status | mode | n | latency s | violations | misses |
|---|---|---|---|---|---|---|---|
| D01 | dev | ok | live_rag | 2 | 46.4 | 0 | 0 |
| D02 | dev | no_match | retrieval_only | 0 | 0.0 | 0 | 0 |
| D03 | dev | ok | live_rag | 3 | 62.3 | 0 | 0 |
| D04 | dev | ok | live_rag | 3 | 72.7 | 0 | no result in categories ['cafe'] |
| D05 | dev | ok | live_rag | 3 | 62.3 | 0 | 0 |
| D06 | dev | ok | live_rag | 1 | 47.8 | 0 | 0 |
| D07 | dev | no_match | retrieval_only | 0 | 0.2 | 0 | 0 |
| D08 | dev | ok | live_rag | 3 | 66.8 | 0 | no result in categories ['food', 'cafe'] |
| D09 | dev | ok | live_rag | 3 | 65.6 | 0 | 0 |
| D10 | dev | ok | live_rag | 2 | 45.7 | 0 | 0 |
| H01 | holdout | ok | live_rag | 2 | 43.5 | 0 | 0 |
| H02 | holdout | ok | live_rag | 3 | 58.7 | 0 | 0 |
| H03 | holdout | ok | live_rag | 2 | 52.6 | 0 | 0 |
| H04 | holdout | ok | live_rag | 2 | 56.1 | 0 | 0 |
| H05 | holdout | ok | live_rag | 2 | 36.7 | 0 | 0 |
| H06 | holdout | no_match | retrieval_only | 0 | 0.2 | 0 | 0 |
| H07 | holdout | ok | live_rag | 1 | 22.0 | 0 | 0 |
| H08 | holdout | no_match | retrieval_only | 0 | 0.2 | 0 | 0 |
| H09 | holdout | needs_clarification | retrieval_only | 0 | 0.0 | 0 | 0 |
| H10 | holdout | ok | live_rag | 3 | 79.8 | 0 | 0 |

hard-constraint/grounding violations: 0
