# Eval results
date: 20261018T221419Z
api: http://127.0.0.1:8000

| id | split | status | mode | n | latency s | violations | misses |
|---|---|---|---|---|---|---|---|
| D01 | dev | ok | live_rag | 2 | 61.9 | 0 | 0 |
| D02 | dev | no_match | retrieval_only | 0 | 0.0 | 0 | 0 |
| D03 | dev | ok | live_rag | 3 | 58.6 | 0 | 0 |
| D04 | dev | ok | live_rag | 3 | 48.7 | 0 | no result in categories ['cafe'] |
| D05 | dev | ok | live_rag | 2 | 57.3 | 0 | 0 |
| D06 | dev | ok | live_rag | 3 | 54.3 | 0 | 0 |
| D07 | dev | no_match | retrieval_only | 0 | 0.4 | 0 | 0 |
| D08 | dev | ok | live_rag | 3 | 65.7 | 0 | no result in categories ['food', 'cafe'] |
| D09 | dev | ok | live_rag | 2 | 55.1 | 0 | 0 |
| D10 | dev | ok | live_rag | 2 | 37.8 | 0 | 0 |
| H01 | holdout | ok | live_rag | 2 | 34.6 | 0 | 0 |
| H02 | holdout | ok | live_rag | 2 | 43.4 | 0 | 0 |
| H03 | holdout | ok | live_rag | 2 | 89.0 | 0 | 0 |
| H04 | holdout | ok | live_rag | 2 | 62.1 | 0 | 0 |
| H05 | holdout | ok | live_rag | 2 | 38.0 | 0 | 0 |
| H06 | holdout | no_match | retrieval_only | 0 | 0.2 | 0 | 0 |
| H07 | holdout | ok | live_rag | 1 | 22.8 | 0 | 0 |
| H08 | holdout | no_match | retrieval_only | 0 | 0.2 | 0 | 0 |
| H09 | holdout | needs_clarification | retrieval_only | 0 | 0.0 | 0 | 0 |
| H10 | holdout | ok | live_rag | 2 | 48.1 | 0 | 0 |

hard-constraint/grounding violations: 0
