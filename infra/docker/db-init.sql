CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE DATABASE smartcity_test OWNER smartcity;
\connect smartcity_test
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;
\connect smartcity
CREATE DATABASE smartcity_test_ingest OWNER smartcity;
\connect smartcity_test_ingest
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;
