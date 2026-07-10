class DataPipeline:

    def run(self, records, strict):
        cleaned = self._clean(records)
        if strict:
            return self.__validate(cleaned)
        return cleaned

    # TODO: this should stream records instead of building the whole list in memory.
    def _clean(self, records):
        result = []
        for record in records:
            if record is None:
                continue
            if isinstance(record, dict) and record.get("value") is not None:
                result.append(record)
            elif isinstance(record, list):
                for item in record:
                    if item and len(item) > 0:
                        result.append(item)
        return result

    def __validate(self, records):
        try:
            return [r for r in records if r["value"] > 0]
        except KeyError:
            pass
        return []

    @deprecated("use run() instead")
    def legacy_process(self, records):
        return self.run(records, True)
