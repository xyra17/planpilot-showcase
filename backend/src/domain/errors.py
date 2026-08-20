class DomainVersionConflict(RuntimeError):
    def __init__(self, entity: str, entity_id: str, expected: int, actual: int) -> None:
        self.entity = entity
        self.entity_id = entity_id
        self.expected = expected
        self.actual = actual
        super().__init__(f"{entity} 已更新：期望版本 {expected}，当前版本 {actual}")
